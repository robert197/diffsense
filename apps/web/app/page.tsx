export default function Home() {
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: "2rem" }}>
      <div style={{ maxWidth: 520, textAlign: "center" }}>
        <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>diffsense</h1>
        <p style={{ opacity: 0.7, lineHeight: 1.5 }}>
          The hosted, advisory card view over review findings. Open a specific PR at{" "}
          <code>/pr/&lt;owner&gt;/&lt;repo&gt;/&lt;number&gt;</code> — the link is in the diffsense
          PR comment.
        </p>
      </div>
    </main>
  );
}
