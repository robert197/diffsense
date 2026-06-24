// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddableReposResult } from "../../lib/addableRepos";

// The modal loads its data through the server action; mock it so we drive the
// load states deterministically without a session or network.
const loadAddableRepos = vi.fn<[], Promise<AddableReposResult>>();
vi.mock("../../app/repos/actions", () => ({
  loadAddableRepos: () => loadAddableRepos(),
}));

import { AddRepositoriesModal } from "./AddRepositoriesModal";

const LOADED: AddableReposResult = {
  installNewUrl: "https://github.com/apps/diffsense/installations/new",
  installableTargets: [
    { account: "devs-group", accountType: "Organization", installType: "request" },
    { account: "owned-org", accountType: "Organization", installType: "install" },
  ],
  groups: [
    {
      account: "acme",
      accountType: "Organization",
      manageUrl: "https://github.com/organizations/acme/settings/installations/7",
      repos: [
        { owner: "acme", name: "fresh", fullName: "acme/fresh", private: false, pushedAt: null },
        { owner: "acme", name: "secret", fullName: "acme/secret", private: true, pushedAt: null },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  loadAddableRepos.mockReset();
});

function openModal() {
  fireEvent.click(screen.getByRole("button", { name: /add repositories/i }));
}

describe("AddRepositoriesModal", () => {
  it("is closed initially and does not load until opened", () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    expect(loadAddableRepos).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the dialog and loads repos exactly once", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();

    expect(await screen.findByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("acme/fresh")).toBeTruthy());
    expect(loadAddableRepos).toHaveBeenCalledTimes(1);
  });

  it("lists installation repos (private included), each linking to its PRs", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    // A private repo is still shown.
    expect(screen.getByText("acme/secret")).toBeTruthy();
    const reviewLinks = screen.getAllByRole("link", { name: /acme\// });
    const hrefs = reviewLinks.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/repos/acme/fresh/pulls");
    expect(hrefs).toContain("/repos/acme/secret/pulls");
  });

  it("shows a 'Manage repositories on GitHub' link for a selected-repos install", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    const manage = screen.getByRole("link", { name: /manage repositories on github/i });
    expect(manage.getAttribute("href")).toBe(
      "https://github.com/organizations/acme/settings/installations/7",
    );
    expect(manage.getAttribute("target")).toBe("_blank");
  });

  it("omits the manage link when the install grants all repos", async () => {
    loadAddableRepos.mockResolvedValue({
      ...LOADED,
      groups: [{ ...LOADED.groups[0], manageUrl: null }],
    } as AddableReposResult);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    expect(screen.queryByRole("link", { name: /manage repositories on github/i })).toBeNull();
  });

  it("filters repos by name and by owner/name", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    fireEvent.change(screen.getByLabelText(/filter repositories/i), {
      target: { value: "secret" },
    });
    expect(screen.queryByText("acme/fresh")).toBeNull();
    expect(screen.getByText("acme/secret")).toBeTruthy();
  });

  it("labels install vs request cards by role and keeps the owner-approval note", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("devs-group");

    expect(screen.getByText(/add an organisation or account/i)).toBeTruthy();
    expect(screen.getByText(/sends a request to its owners to approve/i)).toBeTruthy();
    // member org -> Request access; admin org -> Install.
    expect(screen.getByRole("link", { name: /request access/i })).toBeTruthy();
    const install = screen.getByRole("link", { name: /^install$/i });
    expect(install.getAttribute("href")).toBe(
      "https://github.com/apps/diffsense/installations/new",
    );
  });

  it("shows a re-auth prompt when the action reports an expired session", async () => {
    loadAddableRepos.mockResolvedValue({ error: "reauth" });
    render(<AddRepositoriesModal />);
    openModal();

    const signIn = await screen.findByRole("link", { name: /sign in again/i });
    expect(signIn.getAttribute("href")).toBe("/login");
  });

  it("shows the not-installed empty state with the install-on-another-account link", async () => {
    loadAddableRepos.mockResolvedValue({
      groups: [],
      installableTargets: [],
      installNewUrl: "https://github.com/apps/diffsense/installations/new",
    });
    render(<AddRepositoriesModal />);
    openModal();

    await screen.findByText(/isn't installed on any of your accounts yet/i);
    const installNew = screen.getByRole("link", { name: /install on another account/i });
    expect(installNew.getAttribute("href")).toBe(
      "https://github.com/apps/diffsense/installations/new",
    );
  });

  it("shows an unknown-error state and re-fetches when Try again is clicked", async () => {
    loadAddableRepos.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(LOADED);
    render(<AddRepositoriesModal />);
    openModal();

    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(screen.getByText(/couldn.t load/i)).toBeTruthy();

    fireEvent.click(retry);
    await screen.findByText("acme/fresh");
    expect(loadAddableRepos).toHaveBeenCalledTimes(2);
  });

  it("omits the installable-accounts section when there are none", async () => {
    loadAddableRepos.mockResolvedValue({ ...LOADED, installableTargets: [] });
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    expect(screen.queryByText(/add an organisation or account/i)).toBeNull();
    expect(screen.getByRole("link", { name: /install on another account/i })).toBeTruthy();
  });

  it("re-fetches on reopen so a just-completed install is reflected", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");
    expect(loadAddableRepos).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    openModal();
    await waitFor(() => expect(loadAddableRepos).toHaveBeenCalledTimes(2));
  });

  it("refreshes the loaded view when the tab regains focus", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");
    expect(loadAddableRepos).toHaveBeenCalledTimes(1);

    // Reviewer returns from GitHub's install screen -> tab becomes visible.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(loadAddableRepos).toHaveBeenCalledTimes(2));
  });

  it("does not refresh on focus while a load is still in flight", async () => {
    // A load that never resolves keeps the modal in the loading state.
    loadAddableRepos.mockReturnValue(new Promise<AddableReposResult>(() => {}));
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText(/loading your repositories/i);
    expect(loadAddableRepos).toHaveBeenCalledTimes(1);

    // Focus while loading must not start a second load (guarded on loaded state).
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    expect(loadAddableRepos).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on focus once the dialog is closed", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const callsAfterClose = loadAddableRepos.mock.calls.length;

    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    expect(loadAddableRepos).toHaveBeenCalledTimes(callsAfterClose);
  });

  it("reflects a newly-synced org on refocus", async () => {
    const withDevsGroup: AddableReposResult = {
      ...LOADED,
      installableTargets: [],
      groups: [
        ...LOADED.groups,
        {
          account: "devs-group",
          accountType: "Organization",
          manageUrl: null,
          repos: [
            {
              owner: "devs-group",
              name: "core-gent",
              fullName: "devs-group/core-gent",
              private: true,
              pushedAt: null,
            },
          ],
        },
      ],
    };
    loadAddableRepos.mockResolvedValueOnce(LOADED).mockResolvedValue(withDevsGroup);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");
    expect(screen.queryByText("devs-group/core-gent")).toBeNull();

    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("devs-group/core-gent");
  });

  it("manual Refresh re-fetches the list", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");
    expect(loadAddableRepos).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(loadAddableRepos).toHaveBeenCalledTimes(2));
  });

  it("marks a target 'opened on GitHub' when its install link is clicked", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("devs-group");

    // Member org -> Request access -> request-flavoured hint, scoped to that target.
    fireEvent.click(screen.getByRole("link", { name: /request access/i }));
    expect(await screen.findByText(/access requested on github/i)).toBeTruthy();
    expect(screen.queryByText(/opened on github/i)).toBeNull();

    // Admin org -> Install -> install-flavoured hint, independent of the first.
    fireEvent.click(screen.getByRole("link", { name: /^install$/i }));
    expect(await screen.findByText(/opened on github/i)).toBeTruthy();
  });

  it("clears opened-target hints after close and reopen", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("devs-group");
    fireEvent.click(screen.getByRole("link", { name: /request access/i }));
    await screen.findByText(/access requested on github/i);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    openModal();
    await screen.findByText("devs-group");
    expect(screen.queryByText(/access requested on github/i)).toBeNull();
  });
});
