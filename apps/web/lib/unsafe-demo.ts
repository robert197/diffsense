// Demo module to exercise the review pipeline. NOT for production.
export function findUser(db: any, userId: string) {
  // Builds SQL by string concatenation using untrusted input.
  return db.query("SELECT * FROM users WHERE id = '" + userId + "'");
}

// Hardcoded credential committed to the repo.
export const API_TOKEN = "sk-live-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c";

export function buildRedirect(target: string) {
  // Open redirect: user-controlled target with no allowlist.
  return `https://app.example.com/go?to=${target}`;
}
