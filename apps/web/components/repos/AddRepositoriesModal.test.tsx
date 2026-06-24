// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddableReposResult } from "../../lib/addableRepos";

// The modal loads its list through the server action; mock it so we drive the
// load states deterministically without a session or network.
const loadAddableRepos = vi.fn<[], Promise<AddableReposResult>>();
vi.mock("../../app/repos/actions", () => ({
  loadAddableRepos: () => loadAddableRepos(),
}));

import { AddRepositoriesModal } from "./AddRepositoriesModal";

const LOADED: AddableReposResult = {
  installNewUrl: "https://github.com/apps/diffsense/installations/new",
  groups: [
    {
      account: "acme",
      accountType: "Organization",
      installUrl: "https://github.com/apps/diffsense/installations/new/permissions?target_id=1",
      repos: [
        {
          owner: "acme",
          name: "fresh",
          fullName: "acme/fresh",
          private: false,
          pushedAt: null,
          added: false,
        },
        {
          owner: "acme",
          name: "tracked",
          fullName: "acme/tracked",
          private: true,
          pushedAt: null,
          added: true,
        },
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

  it("renders an Add link for not-added repos and an Added link for installed ones", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    const addLink = screen.getByRole("link", { name: /^add$/i });
    expect(addLink.getAttribute("href")).toContain("target_id=1");
    expect(addLink.getAttribute("target")).toBe("_blank");

    const addedLink = screen.getByRole("link", { name: /added/i });
    expect(addedLink.getAttribute("href")).toBe("/repos/acme/tracked/pulls");
  });

  it("filters repos by name and by owner/name", async () => {
    loadAddableRepos.mockResolvedValue(LOADED);
    render(<AddRepositoriesModal />);
    openModal();
    await screen.findByText("acme/fresh");

    fireEvent.change(screen.getByLabelText(/filter repositories/i), {
      target: { value: "tracked" },
    });
    expect(screen.queryByText("acme/fresh")).toBeNull();
    expect(screen.getByText("acme/tracked")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/filter repositories/i), {
      target: { value: "acme/fresh" },
    });
    expect(screen.getByText("acme/fresh")).toBeTruthy();
    expect(screen.queryByText("acme/tracked")).toBeNull();
  });

  it("shows a re-auth prompt when the action reports an expired session", async () => {
    loadAddableRepos.mockResolvedValue({ error: "reauth" });
    render(<AddRepositoriesModal />);
    openModal();

    const signIn = await screen.findByRole("link", { name: /sign in again/i });
    expect(signIn.getAttribute("href")).toBe("/login");
  });

  it("shows an empty state with the install-on-another-account link", async () => {
    loadAddableRepos.mockResolvedValue({
      groups: [],
      installNewUrl: "https://github.com/apps/diffsense/installations/new",
    });
    render(<AddRepositoriesModal />);
    openModal();

    await screen.findByText(/no repositories found/i);
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
});
