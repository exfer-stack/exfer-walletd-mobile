// Welcome — the first screen on a fresh install, shown before onboarding
// (set password / restore). Pitches the product in one breath: instant,
// lightweight, yours. "Get started" hands off to <Onboarding>.

import mark from "../assets/exfer-mark.png";

function Point({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      {/* small brand-cyan node, echoing the logo's squares */}
      <span
        style={{
          flex: "0 0 auto",
          width: 9,
          height: 9,
          marginTop: 6,
          borderRadius: 3,
          background: "var(--accent)",
          boxShadow: "0 0 10px var(--accent)",
        }}
      />
      <div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
        <div className="dim" style={{ fontSize: 13.5, lineHeight: 1.5, marginTop: 2 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="screen">
      <div
        className="screen-pad"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
          paddingTop: 8,
        }}
      >
        {/* Hero */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingBottom: 8,
          }}
        >
          <div style={{ position: "relative", width: 96, height: 96, marginBottom: 26 }}>
            <span
              style={{
                position: "absolute",
                inset: -24,
                background:
                  "radial-gradient(circle, color-mix(in srgb,var(--accent) 45%,transparent), transparent 70%)",
                filter: "blur(14px)",
              }}
              aria-hidden="true"
            />
            <img
              src={mark}
              alt="exfer"
              draggable={false}
              style={{ position: "relative", width: 96, height: 96 }}
            />
          </div>

          <div className="eyebrow" style={{ letterSpacing: ".16em", marginBottom: 14 }}>
            exfer wallet
          </div>
          <h1
            style={{
              fontSize: 44,
              lineHeight: 1.02,
              letterSpacing: "-.03em",
              fontWeight: 700,
              margin: "0 0 16px",
            }}
          >
            Transfers that
            <br />
            <span style={{ color: "var(--accent)" }}>arrive instantly.</span>
          </h1>
          <p
            className="dim"
            style={{ fontSize: 15.5, lineHeight: 1.6, margin: "0 0 30px", maxWidth: "30em" }}
          >
            A fast, lightweight wallet for the Exfer blockchain. Funds show up the
            moment they hit the network — no waiting, no server, no account.
          </p>

          <div style={{ display: "grid", gap: 18 }}>
            <Point
              title="Instant"
              body="Incoming EXFER lands in your balance the second it hits the mempool."
            />
            <Point
              title="Lightweight"
              body="The wallet engine runs on your phone. Nothing to install, nothing in the background."
            />
            <Point
              title="Yours"
              body="Keys are generated on the device and never leave it."
            />
          </div>
        </div>

        {/* CTA */}
        <button
          className="btn btn-block"
          style={{ padding: "16px", marginTop: 22 }}
          onClick={onStart}
        >
          Get started
        </button>
        <div className="faint" style={{ fontSize: 12.5, textAlign: "center", marginTop: 12 }}>
          Set a password next, or restore from a backup.
        </div>
      </div>
    </div>
  );
}
