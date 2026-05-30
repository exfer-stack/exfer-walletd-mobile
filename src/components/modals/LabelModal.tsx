// Rename / add a local label for an address (labels are device-local).

import { useState } from "react";
import { Modal, Field } from "../ui";
import { useToast } from "../../lib/toast";
import { getLabel, setLabel } from "../../lib/labels";

export function LabelModal({
  address,
  onClose,
  onSaved,
}: {
  address: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const existing = getLabel(address) ?? "";
  const [draft, setDraft] = useState(existing);

  function save() {
    setLabel(address, draft.trim());
    onSaved();
    toast.success("Label saved");
    onClose();
  }

  return (
    <Modal
      title={existing ? "Rename address" : "Add label"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-block" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <Field help="A private nickname stored on this device only.">
        <input
          className="field"
          autoFocus
          value={draft}
          maxLength={28}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. deposits, savings…"
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </Field>
    </Modal>
  );
}
