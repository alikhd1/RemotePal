import { useState } from "react";
import {
  DEFAULT_TERM_FONT,
  getTermFont,
  setTermFont,
  autoReconnectEnabled,
  setAutoReconnect,
  RECONNECT_ATTEMPTS,
} from "./termFont";

// Terminal appearance. The font matters beyond taste: the default stack
// has to cover whatever scripts you actually see, and open terminals
// pick a change up immediately.
function TerminalCard() {
  const [font, setFont] = useState(getTermFont());
  const [notice, setNotice] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(autoReconnectEnabled());

  function apply(value: string) {
    setTermFont(value);
    setFont(getTermFont());
    setNotice("Font applied to open terminals.");
  }

  return (
    <div className="saved-panel">
      <h2>Terminal</h2>

      <label className="ai-bio-toggle">
        <input
          type="checkbox"
          checked={reconnect}
          onChange={(e) => {
            setAutoReconnect(e.currentTarget.checked);
            setReconnect(e.currentTarget.checked);
          }}
        />
        Reconnect dropped sessions automatically
      </label>
      <div className="saved-empty">
        A session whose connection drops is dialled again up to{" "}
        {RECONNECT_ATTEMPTS} times, waiting longer after each try. A shell you
        exited is left alone — only a lost connection is retried.
      </div>

      <label className="ai-field-label">Font family</label>
      <input
        type="text"
        className="vault-pass"
        value={font}
        spellCheck={false}
        onChange={(e) => setFont(e.currentTarget.value)}
        onBlur={() => apply(font)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply(e.currentTarget.value);
        }}
      />
      <div className="vault-buttons">
        <button type="button" onClick={() => apply(DEFAULT_TERM_FONT)}>
          Reset to default
        </button>
      </div>

      <div className="saved-empty">
        A CSS font list, tried left to right for each character. The default
        keeps Latin and box drawing in Consolas and falls back for scripts it
        does not cover, such as Arabic and Persian. Put your preferred font
        first if you have one installed.
        <br />
        <br />
        Arabic-script text renders as separate letters in logical order:
        the terminal does not join letters or reorder right-to-left.
      </div>

      {notice && <div className="connect-notice">{notice}</div>}
    </div>
  );
}

export default TerminalCard;
