import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DeleteAccountPage from "@/app/(app)/profile/delete/page";
import { UserAvatar } from "@/components/shared/user-avatar";
import { EditProfileDialog } from "./edit-profile-dialog";

/** Server-render with a QueryClient whose cache is pre-filled, the way the hooks read it on first paint. */
function render(ui: ReactElement, seed: [string, unknown][] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [path, data] of seed) client.setQueryData(["rpc", path, {}], data);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const summary = {
  email: "ada@example.com",
  plan: "free",
  videoCount: 3,
  storageBytes: 5 * 1024 * 1024,
  channelCount: 1,
  ideaCount: 2,
  aiSessionCount: 1,
  hasActiveSubscription: false,
};

describe("UserAvatar", () => {
  test("shows initials when there is no picture, and labels itself for screen readers", () => {
    const html = render(<UserAvatar name="Ada Lovelace" email="ada@example.com" size={48} />);
    expect(html).toContain("AL");
    expect(html).toContain('aria-label="Ada Lovelace"');
    expect(html).toContain("width:48px");
    expect(render(<UserAvatar email="blairryhs@gmail.com" />)).toContain(">B<");
    expect(render(<UserAvatar />)).toContain(">?<");
  });

  test("shows the picture when there is one", () => {
    const html = render(<UserAvatar name="Ada" imageUrl="https://res.cloudinary.com/demo/image/upload/v1/reelcast/avatars/u/a.jpg" size={32} />);
    expect(html).toContain("<img");
    expect(html).toContain('alt="Ada"');
  });
});

describe("EditProfileDialog", () => {
  const user = { name: "Ada Lovelace", email: "ada@example.com", imageUrl: null };

  test("renders nothing while closed", () => {
    expect(render(<EditProfileDialog open={false} onOpenChange={() => {}} user={user} />)).toBe("");
  });

  test("open: a labelled dialog with the name prefilled, a locked email, photo controls and a disabled Save", () => {
    const html = render(<EditProfileDialog open onOpenChange={() => {}} user={user} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Edit profile");
    expect(html).toContain('value="Ada Lovelace"');
    expect(html).toContain("data-autofocus");
    const emailInput = /<input[^>]*id="profile-email"[^>]*>/.exec(html)?.[0] ?? "";
    expect(emailInput).toContain('value="ada@example.com"');
    expect(emailInput).toContain("readOnly");
    expect(emailInput).toContain("disabled");
    expect(html).toMatch(/aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"/); // the dialog is named by its title
    expect(html).toContain("Upload photo"); // no picture yet
    expect(html).not.toContain("Remove photo");
    expect(html).toMatch(/<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/); // nothing changed: Save is off
    expect(html).toContain("12/60");
  });

  test("with a picture it offers Change and Remove", () => {
    const html = render(
      <EditProfileDialog open onOpenChange={() => {}} user={{ ...user, imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/reelcast/avatars/u/a.jpg" }} />,
    );
    expect(html).toContain("Change photo");
    expect(html).toContain("Remove photo");
  });
});

describe("DeleteAccountPage", () => {
  test("lists what will be deleted with the user's real numbers and starts with deleting disabled", () => {
    const html = render(<DeleteAccountPage />, [["users.deletionSummary", summary]]);
    expect(html).toContain("Delete account");
    expect(html).toContain("3 videos");
    expect(html).toContain("5.0 MB");
    expect(html).toContain("2 saved ideas");
    expect(html).toContain("1 AI assistant conversation");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("stay on YouTube");
    expect(html).toContain("This cannot be undone");
    expect(html).not.toContain("only admin");
    expect(html).not.toContain("plan. Deleting"); // free plan: no billing warning
    expect(html).toMatch(/<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/);
  });

  test("warns about an active paid plan", () => {
    const html = render(<DeleteAccountPage />, [["users.deletionSummary", { ...summary, plan: "pro", hasActiveSubscription: true }]]);
    expect(html).toContain("Deleting your account ends it immediately");
    expect(html).toContain("no refund");
  });

  test("tells the only admin they cannot delete yet, and keeps every input disabled", () => {
    const html = render(<DeleteAccountPage />, [["users.deletionSummary", { ...summary, blockedReason: "last_admin" }]]);
    expect(html).toContain("only admin");
    expect(html).toMatch(/<input[^>]*id="confirm-email"[^>]*disabled/);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
  });

  test("an empty account reads sensibly", () => {
    const html = render(<DeleteAccountPage />, [
      ["users.deletionSummary", { ...summary, videoCount: 0, storageBytes: 0, channelCount: 0, ideaCount: 0, aiSessionCount: 0 }],
    ]);
    expect(html).toContain("Your uploads, generated videos and their files");
    expect(html).not.toContain("0 videos");
  });

  test("shows a spinner, not a crash, while the summary loads", () => {
    expect(() => render(<DeleteAccountPage />)).not.toThrow();
  });
});
