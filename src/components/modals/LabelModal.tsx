// Rename / add a local label for an address (labels are device-local).

import { useState } from "react";
import { Modal, Field } from "../ui";
import { useToast } from "../../lib/toast";
import { useT } from "../../lib/i18n";
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
  const { t } = useT();
  const existing = getLabel(address) ?? "";
  const [draft, setDraft] = useState(existing);

  function save() {
    setLabel(address, draft.trim());
    onSaved();
    toast.success(t("lbl.saved"));
    onClose();
  }

  return (
    <Modal
      title={existing ? t("lbl.renameTitle") : t("lbl.addTitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary btn-block" onClick={onClose}>
            {t("sheet.cancel")}
          </button>
          <button className="btn btn-block" onClick={save}>
            {t("lbl.save")}
          </button>
        </>
      }
    >
      <Field help={t("lbl.help")}>
        <input
          className="field"
          autoFocus
          value={draft}
          maxLength={28}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("lbl.placeholder")}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
      </Field>
    </Modal>
  );
}
