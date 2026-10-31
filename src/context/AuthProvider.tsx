import React, { createContext, useContext, useEffect, useState } from "react";
import {
  auth,
  isApiKeyConfigured,
  googleProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateFirebaseProfile,
  onAuthStateChanged,
} from "@/lib/firebase";
import { api, setAuthToken } from "@/lib/api";
import { UserProfile, UserRole } from "@/types/auth";
import { toast } from "sonner";

interface AuthContextType {
  user: UserProfile | null;
  firebaseUser: any | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  loginWithEmail: (email: string, pass: string) => Promise<void>;
  registerWithEmail: (
    email: string,
    pass: string,
    fullName: string,
    requestedRole: UserRole
  ) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Synchronize authenticated Firebase user with MongoDB profile
  const syncWithBackend = async (fbUser: any, requestedRole?: UserRole) => {
    try {
      const token = await fbUser.getIdToken(true);
      setAuthToken(token);

      const response = await api.post("/auth/session", {
        email: fbUser.email,
        fullName: fbUser.displayName || fbUser.email?.split("@")[0] || "User",
        avatar: fbUser.photoURL || "",
        requestedRole: requestedRole || "resident",
      });

      if (response.data.success) {
        setUser(response.data.user);
      } else {
        throw new Error(response.data.error || "Failed to synchronize profile");
      }
    } catch (err: any) {
      console.error("[AuthProvider] Profile synchronization error:", err);
      const message =
        err.response?.data?.error ||
        err.message ||
        "Could not verify session with application server.";
      toast.error(message);
      setUser(null);
      throw err;
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        try {
          await syncWithBackend(fbUser);
        } catch (e) {
          // Token verification failed or backend rejected
        }
      } else {
        setAuthToken(null);
        setUser(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    if (!isApiKeyConfigured) {
      toast.error("VITE_FIREBASE_API_KEY is not configured in Frontend/.env. Please paste your web API key from Firebase Console.");
      return;
    }
    setLoading(true);
    try {
      const res = await signInWithPopup(auth, googleProvider);
      await syncWithBackend(res.user);
      toast.success("Successfully authenticated with Google!");
    } catch (error: any) {
      console.error("[Google Auth Error]:", error);
      let message = "Google authentication failed.";
      if (error.code === "auth/popup-closed-by-user") {
        message = "Google sign-in popup was closed before completion.";
      } else if (error.code === "auth/account-exists-with-different-credential") {
        message = "An account already exists with this email using another sign-in method.";
      } else if (error.message) {
        message = error.message;
      }
      toast.error(message);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const loginWithEmail = async (email: string, pass: string) => {
    if (!isApiKeyConfigured) {
      toast.error("VITE_FIREBASE_API_KEY is not configured in Frontend/.env. Please paste your web API key from Firebase Console.");
      return;
    }
    setLoading(true);
    try {
      const res = await signInWithEmailAndPassword(auth, email.trim(), pass);
      await syncWithBackend(res.user);
      toast.success("Welcome back! Logged in successfully.");
    } catch (error: any) {
      console.error("[Email Login Error]:", error);
      let message = "Invalid email address or password.";
      if (error.code === "auth/user-not-found" || error.code === "auth/wrong-password" || error.code === "auth/invalid-credential") {
        message = "Invalid email address or password.";
      } else if (error.code === "auth/too-many-requests") {
        message = "Too many failed attempts. Access temporarily disabled. Please reset password or try later.";
      } else if (error.message) {
        message = error.message;
      }
      toast.error(message);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const registerWithEmail = async (
    email: string,
    pass: string,
    fullName: string,
    requestedRole: UserRole
  ) => {
    if (!isApiKeyConfigured) {
      toast.error("VITE_FIREBASE_API_KEY is not configured in Frontend/.env. Please paste your web API key from Firebase Console.");
      return;
    }
    setLoading(true);
    try {
      const res = await createUserWithEmailAndPassword(auth, email.trim(), pass);
      await updateFirebaseProfile(res.user, { displayName: fullName.trim() });
      try {
        await sendEmailVerification(res.user);
      } catch (e) {
        console.warn("Email verification dispatch error:", e);
      }
      await syncWithBackend(res.user, requestedRole);
      toast.success("Account created! A verification link has been sent to your email.");
    } catch (error: any) {
      console.error("[Email Registration Error]:", error);
      let message = "Failed to create account.";
      if (error.code === "auth/email-already-in-use") {
        message = "An account with this email address already exists.";
      } else if (error.code === "auth/weak-password") {
        message = "Password is too weak. Please choose a stronger password.";
      } else if (error.message) {
        message = error.message;
      }
      toast.error(message);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const resetPassword = async (email: string) => {
    try {
      await sendPasswordResetEmail(auth, email.trim());
      toast.success("Password reset email sent! Check your inbox.");
    } catch (error: any) {
      console.error("[Password Reset Error]:", error);
      toast.error(error.message || "Failed to send password reset email.");
      throw error;
    }
  };

  const resendVerification = async () => {
    if (auth.currentUser) {
      try {
        await sendEmailVerification(auth.currentUser);
        toast.success("Verification email resent.");
      } catch (err: any) {
        toast.error(err.message || "Failed to resend verification email.");
      }
    } else {
      toast.error("No active user session to send verification.");
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      await api.post("/auth/logout").catch(() => {});
    } catch (e) {
      // Ignored
    } finally {
      setAuthToken(null);
      setFirebaseUser(null);
      setUser(null);
      toast.success("Logged out successfully.");
    }
  };

  const refreshProfile = async () => {
    if (firebaseUser) {
      await syncWithBackend(firebaseUser);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        firebaseUser,
        loading,
        signInWithGoogle,
        loginWithEmail,
        registerWithEmail,
        resetPassword,
        resendVerification,
        logout,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
