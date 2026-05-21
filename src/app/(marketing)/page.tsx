export default function LandingPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-73px)] px-6 text-center">
      <div className="max-w-3xl animate-fade-in">
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground">
          From raw footage to <span className="text-primary">live YouTube video</span> — automatically
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          Upload your raw video. ReelCast runs AI enhancement, generates titles, descriptions, and tags, then publishes
          directly to your YouTube channel on your schedule.
        </p>
        <div className="mt-10 flex gap-4 justify-center">
          <a
            href="/sign-up"
            className="bg-primary text-primary-foreground px-8 py-3 rounded-md text-lg font-medium hover:bg-primary/90 transition-colors"
          >
            Start for Free
          </a>
          <a
            href="#how-it-works"
            className="bg-secondary text-secondary-foreground px-8 py-3 rounded-md text-lg font-medium hover:bg-secondary/80 transition-colors"
          >
            How It Works
          </a>
        </div>
      </div>

      <section id="how-it-works" className="mt-32 w-full max-w-5xl">
        <h2 className="text-3xl font-bold text-center mb-12">Three steps. Zero manual work.</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            {
              step: "1",
              title: "Upload",
              desc: "Drag and drop your raw footage. Files upload directly to cloud storage — nothing touches our servers.",
            },
            {
              step: "2",
              title: "AI Processing",
              desc: "Our AI engine enhances your video and generates a title, description, and tags optimized for YouTube.",
            },
            {
              step: "3",
              title: "Publish",
              desc: "Review the AI metadata, make edits if you want, then publish or schedule directly to your YouTube channel.",
            },
          ].map((item) => (
            <div key={item.step} className="bg-card border border-border rounded-lg p-6 text-left">
              <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center text-lg mb-4">
                {item.step}
              </div>
              <h3 className="text-xl font-semibold mb-2">{item.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
