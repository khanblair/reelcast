export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md animate-fade-in">
        <div className="text-center mb-8">
          <span className="text-2xl font-bold text-primary">ReelCast</span>
        </div>
        {children}
      </div>
    </div>
  );
}
