import type { CSSProperties } from "react";

/**
 * The sign-out control (issue #25). A POST to /logout (the route deletes the
 * session row and clears the cookie). Shared so the home and repos screens don't
 * hand-maintain two copies of the same form + button.
 */

const linkStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#9ca3af",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: "0.85rem",
};

const pillStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid #374151",
  color: "#9ca3af",
  borderRadius: 8,
  padding: "0.45rem 0.7rem",
  cursor: "pointer",
  fontSize: "0.8rem",
};

export function SignOutButton({ variant = "link" }: { variant?: "link" | "pill" }) {
  return (
    <form action="/logout" method="post">
      <button type="submit" style={variant === "pill" ? pillStyle : linkStyle}>
        Sign out
      </button>
    </form>
  );
}
