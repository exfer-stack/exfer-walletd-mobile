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
          position: "relative",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
          paddingTop: 8,
        }}
      >
        {/* Flat brand mark as a faint background backdrop — no glow. */}
        <img
          src={mark}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{
            position: "absolute",
            top: 40,
            right: -120,
            width: 400,
            height: 400,
            opacity: 0.06,
            pointerEvents: "none",
            userSelect: "none",
            zIndex: 0,
          }}
        />
        {/* Hero */}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingBottom: 8,
          }}
        >
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
              body="Incoming EXFER shows up in your balance the moment it's sent — no waiting for it to confirm."
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
          style={{ position: "relative", zIndex: 1, padding: "16px", marginTop: 22 }}
          onClick={onStart}
        >
          Get started
        </button>
        <div
          className="faint"
          style={{ position: "relative", zIndex: 1, fontSize: 12.5, textAlign: "center", marginTop: 12 }}
        >
          Set a password next, or restore from a backup.
        </div>
      </div>
    </div>
  );
}
