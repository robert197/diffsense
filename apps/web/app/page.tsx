import {
  ArrowRight,
  Github,
  Layers,
  ListOrdered,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import { SignOutButton } from "../components/SignOutButton";
import { Logo } from "../components/site/Logo";
import { Button } from "../components/ui/button";
import { getSession } from "../lib/auth/session";

const FEATURES = [
  {
    icon: ListOrdered,
    title: "Risk-ordered",
    body: "The riskiest changes surface first, so finite attention lands where it matters.",
  },
  {
    icon: MessageSquareText,
    title: "Plain-language",
    body: "Every change is explained in words, with what could go wrong called out.",
  },
  {
    icon: ShieldCheck,
    title: "Advisory only",
    body: "Signal, not a gate. diffsense never merges, approves, or blocks a PR.",
  },
];

/**
 * The entry path home (issue #25). Signed-out reviewers get a "Sign in with
 * GitHub" call to action; signed-in reviewers get a link into their accessible
 * repos. Advisory product — no merge/approve controls anywhere.
 */

export const dynamic = "force-dynamic";

type SearchParams = { error?: string };

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { error } = await searchParams;
  const session = await getSession();

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-6 py-16">
      {/* Ambient brand glow — sets the tone without competing with the content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/3 rounded-full bg-primary/15 blur-[120px]"
      />

      <div className="w-full max-w-2xl text-center animate-[var(--animate-in)]">
        <div className="mb-8 flex justify-center">
          <Logo size="lg" />
        </div>

        <h1 className="mx-auto max-w-md text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Reviewing AI code at AI speed
        </h1>
        <p className="mx-auto mt-4 max-w-md text-pretty leading-relaxed text-muted-foreground">
          AI writes code faster than anyone can review it. diffsense points you at the few changes
          that actually carry risk — riskiest first, explained in plain language, without leaving
          GitHub.
        </p>

        {error === "auth" && (
          <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            Sign-in didn&apos;t complete. Please try again.
          </p>
        )}

        {session ? (
          <div className="mt-8 flex flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{session.login}</span>
            </p>
            <div className="flex w-full flex-col gap-2.5 sm:flex-row sm:justify-center">
              <Button asChild size="lg">
                <a href="/repos">
                  <Layers />
                  Your repositories
                  <ArrowRight />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="/reviews">Continue reviewing</a>
              </Button>
            </div>
            <SignOutButton variant="link" />
          </div>
        ) : (
          <div className="mt-8 flex flex-col items-center gap-3">
            <Button asChild size="lg">
              <a href="/login">
                <Github />
                Sign in with GitHub
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">
              Read-only and advisory. diffsense never merges, approves, or blocks.
            </p>
          </div>
        )}

        {!session && (
          <div className="mt-12 grid gap-3 text-left sm:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-xl border border-border bg-card/60 p-4 shadow-card"
              >
                <f.icon className="size-5 text-primary" />
                <h2 className="mt-2.5 text-sm font-semibold">{f.title}</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
