import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

export default function SSOCallback() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <AuthenticateWithRedirectCallback />
    </div>
  );
}
