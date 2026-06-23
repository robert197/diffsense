import { LogOut } from "lucide-react";
import { Button } from "./ui/button";

/**
 * The sign-out control (issue #25). A POST to /logout (the route deletes the
 * session row and clears the cookie). Shared so the home and header don't
 * hand-maintain two copies of the same form + button.
 */
export function SignOutButton({ variant = "link" }: { variant?: "link" | "pill" }) {
  return (
    <form action="/logout" method="post">
      {variant === "pill" ? (
        <Button type="submit" variant="outline" size="sm" className="text-muted-foreground">
          <LogOut />
          Sign out
        </Button>
      ) : (
        <Button type="submit" variant="link" className="text-muted-foreground text-sm">
          Sign out
        </Button>
      )}
    </form>
  );
}
