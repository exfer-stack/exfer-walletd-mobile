// Welcome — the first screen on a fresh install, shown before onboarding
// (set password / restore). Pitches the product in one breath: instant,
// lightweight, yours. "Get started" hands off to <Onboarding>. Also the first
// place the user can pick a language (default English).

import mark from "../assets/exfer-mark.png";
import { useT, LANGS, type Lang } from "../lib/i18n";

function Point({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
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

function LangSwitch({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        zIndex: 2,
        display: "flex",
        gap: 2,
        padding: 3,
        borderRadius: 999,
        background: "var(--surface-2)",
        border: "1px solid var(--border-soft)",
      }}
    >
      {LANGS.map((l) => (
        <button
          key={l.key}
          onClick={() => setLang(l.key)}
          style={{
            border: 0,
            cursor: "pointer",
            font: "inherit",
            fontSize: 12.5,
            fontWeight: 600,
            padding: "5px 11px",
            borderRadius: 999,
            background: lang === l.key ? "var(--accent)" : "transparent",
            color: lang === l.key ? "var(--accent-ink)" : "var(--text-dim)",
          }}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

export function Welcome({
  onStart,
  lang,
  setLang,
}: {
  onStart: () => void;
  lang: Lang;
  setLang: (l: Lang) => void;
}) {
  const { t } = useT();
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
        <LangSwitch lang={lang} setLang={setLang} />

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
            {t("welcome.h1a")}
            <br />
            <span style={{ color: "var(--accent)" }}>{t("welcome.h1b")}</span>
          </h1>
          <p
            className="dim"
            style={{ fontSize: 15.5, lineHeight: 1.6, margin: "0 0 30px", maxWidth: "30em" }}
          >
            {t("welcome.lede")}
          </p>

          <div style={{ display: "grid", gap: 18 }}>
            <Point title={t("welcome.instant.t")} body={t("welcome.instant.b")} />
            <Point title={t("welcome.light.t")} body={t("welcome.light.b")} />
            <Point title={t("welcome.yours.t")} body={t("welcome.yours.b")} />
          </div>
        </div>

        {/* CTA */}
        <button
          className="btn btn-block"
          style={{ position: "relative", zIndex: 1, padding: "16px", marginTop: 22 }}
          onClick={onStart}
        >
          {t("welcome.cta")}
        </button>
        <div
          className="faint"
          style={{ position: "relative", zIndex: 1, fontSize: 12.5, textAlign: "center", marginTop: 12 }}
        >
          {t("welcome.hint")}
        </div>
      </div>
    </div>
  );
}
