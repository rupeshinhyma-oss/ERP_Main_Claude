/**
 * Profile Page.
 *
 * Allows logged in users to view and update their profile details
 * (First Name, Last Name, Email, Contact Number) and change password.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Banner } from "@/components/ui";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/hooks";

interface UserProfileData {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email: string;
  phone?: string | null;
  username: string;
}

export function ProfilePage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  /* Profile Form state */
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  /* Password Form state */
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await apiGet<UserProfileData>("/auth/profile");
        const data = res.data;
        if (data) {
          setFirstName(data.first_name || "");
          setLastName(data.last_name || "");
          setEmail(data.email || "");
          setPhone(data.phone || "");
        }
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.id) return;
    setError(null);
    setSuccessMsg(null);
    setSavingProfile(true);

    try {
      await apiPatch(`/users/${profile.id}`, {
        first_name: firstName.trim() || null,
        last_name: lastName.trim() || null,
        email: email.trim(),
        phone: phone.trim() || null,
      });
      setSuccessMsg("Profile information updated successfully!");
    } catch (err) {
      setError(err);
    } finally {
      setSavingProfile(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (!currentPassword) {
      setPasswordError("Please enter your current password.");
      return;
    }
    if (!newPassword) {
      setPasswordError("Please enter a new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirm password do not match.");
      return;
    }

    setSavingPassword(true);
    try {
      await apiPost("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setPasswordSuccess("Password changed successfully!");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to change password.");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <AppShell activeKey="profile">
      <main className="page" style={{ background: "#f8fafc", minHeight: "calc(100vh - 60px)", padding: "24px 36px" }}>
        {/* Top Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
          <h1 style={{ color: "#0f172a", fontWeight: 700, fontSize: "22px", margin: 0 }}>
            Profile
          </h1>
          <button
            type="button"
            className="btn"
            style={{
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              color: "#334155",
              fontWeight: 600,
              fontSize: "13px",
              padding: "8px 16px",
              borderRadius: "6px",
              cursor: "pointer",
            }}
            onClick={() => navigate(-1)}
          >
            &larr; BACK
          </button>
        </div>

        <Banner error={error} />
        {successMsg && (
          <div className="banner banner-success" style={{ marginBottom: "20px" }}>
            {successMsg}
          </div>
        )}

        {/* Profile Card */}
        <div
          className="card"
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            border: "1px solid #e2e8f0",
            padding: "28px 32px",
            marginBottom: "28px",
          }}
        >
          <form onSubmit={handleProfileSubmit}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: "24px",
                marginBottom: "28px",
              }}
            >
              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#334155", marginBottom: "8px" }}>
                  First Name <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="text"
                  value={firstName}
                  disabled={loading}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Enter First Name"
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "14px",
                    color: "#0f172a",
                    outline: "none",
                  }}
                  required
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#334155", marginBottom: "8px" }}>
                  Last Name <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="text"
                  value={lastName}
                  disabled={loading}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Enter Last Name"
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "14px",
                    color: "#0f172a",
                    outline: "none",
                  }}
                  required
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#334155", marginBottom: "8px" }}>
                  Email <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="email"
                  value={email}
                  disabled={loading}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter Email"
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "14px",
                    color: "#0f172a",
                    outline: "none",
                  }}
                  required
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#334155", marginBottom: "8px" }}>
                  Contact Number <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="text"
                  value={phone}
                  disabled={loading}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Enter Contact Number"
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "14px",
                    color: "#0f172a",
                    outline: "none",
                  }}
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingProfile || loading}
              style={{
                background: "#0061f2",
                color: "#ffffff",
                padding: "10px 28px",
                borderRadius: "6px",
                border: "none",
                fontWeight: 600,
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              {savingProfile ? "Updating..." : "Update"}
            </button>
          </form>
        </div>

        {/* Change Password Card */}
        <h2 style={{ color: "#0f172a", fontWeight: 700, fontSize: "18px", marginBottom: "16px" }}>
          Change Password
        </h2>

        {passwordError && (
          <div className="banner banner-danger" style={{ marginBottom: "16px" }}>
            {passwordError}
          </div>
        )}
        {passwordSuccess && (
          <div className="banner banner-success" style={{ marginBottom: "16px" }}>
            {passwordSuccess}
          </div>
        )}

        <div
          className="card"
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            border: "1px solid #e2e8f0",
            padding: "28px 32px",
          }}
        >
          <form onSubmit={handlePasswordSubmit}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "24px",
                marginBottom: "28px",
              }}
            >
              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#334155", marginBottom: "8px" }}>
                  Current Password <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    type={showCurrent ? "text" : "password"}
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Current Password"
                    style={{
                      width: "100%",
                      padding: "10px 40px 10px 14px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "14px",
                      color: "#0f172a",
                      outline: "none",
                    }}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrent((v) => !v)}
                    style={{
                      position: "absolute",
                      right: "12px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "#64748b",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {showCurrent ? "🙈" : "👁️"}
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#334155", marginBottom: "8px" }}>
                  New Password <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    type={showNew ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter your New Password"
                    style={{
                      width: "100%",
                      padding: "10px 40px 10px 14px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "14px",
                      color: "#0f172a",
                      outline: "none",
                    }}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    style={{
                      position: "absolute",
                      right: "12px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "#64748b",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {showNew ? "🙈" : "👁️"}
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#334155", marginBottom: "8px" }}>
                  Confirm New Password <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm New Password"
                    style={{
                      width: "100%",
                      padding: "10px 40px 10px 14px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "14px",
                      color: "#0f172a",
                      outline: "none",
                    }}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    style={{
                      position: "absolute",
                      right: "12px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "#64748b",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {showConfirm ? "🙈" : "👁️"}
                  </button>
                </div>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingPassword}
              style={{
                background: "#0061f2",
                color: "#ffffff",
                padding: "10px 28px",
                borderRadius: "6px",
                border: "none",
                fontWeight: 600,
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              {savingPassword ? "Updating..." : "Update"}
            </button>
          </form>
        </div>
      </main>
    </AppShell>
  );
}
