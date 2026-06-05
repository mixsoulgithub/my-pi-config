/**
 * Ctrl+X Prefix Editor — Emacs-style prefix key support for pi.
 *
 * Drop into ~/.pi/agent/extensions/ctrlx-prefix.ts for auto-discovery.
 *
 * Default prefix bindings:
 *   Ctrl+X e  →  Open current prompt in $VISUAL / $EDITOR
 *
 * Extend `SUB_BINDINGS` below to add more (e.g., Ctrl+X s to save, Ctrl+X c to quit).
 *
 * Cross-computer management: sync ~/.pi/agent/extensions/ctrlx-prefix.ts
 * via dotfiles, git repo, or package as an npm/git pi package.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Sub-binding definitions ────────────────────────────────────────────────
// Add entries here to extend Ctrl+X prefix combos.
// Key: single character pressed after Ctrl+X
// Value: { description, handler(editor, api) }

interface SubBinding {
  description: string;
  handler: (editor: CtrlXEditor, api: ExtensionAPI) => void;
}

const SUB_BINDINGS: Record<string, SubBinding> = {
  e: {
    description: "Edit prompt in $EDITOR",
    handler: (editor, _api) => openExternalEditor(editor),
  },
  // Examples — uncomment and fill in:
  //
  // s: {
  //   description: "Save session checkpoint",
  //   handler: (_editor, api) => {
  //     api.appendEntry("ctrlx-checkpoint", { ts: Date.now() });
  //   },
  // },
  //
  // c: {
  //   description: "Quit pi",
  //   handler: (_editor, _api) => {
  //     process.exit(0);
  //   },
  // },
};

// ── Editor class ───────────────────────────────────────────────────────────

class CtrlXEditor extends CustomEditor {
  prefixActive = false;

  handleInput(data: string): void {
    // Ctrl+X → enter prefix mode
    if (matchesKey(data, "ctrl+x")) {
      this.prefixActive = true;
      return;
    }

    // Inside prefix mode → dispatch to sub-binding
    if (this.prefixActive) {
      this.prefixActive = false;
      const binding = SUB_BINDINGS[data];
      if (binding) {
        // Defer so this input frame finishes cleanly
        const api = this._api;
        queueMicrotask(() => binding.handler(this, api));
      }
      return;
    }

    // Everything else → default editor behaviour
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length > 0 && this.prefixActive) {
      const label = " C-x ";
      const last = lines.length - 1;
      if (visibleWidth(lines[last]!) >= label.length) {
        lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
      }
    }
    return lines;
  }

  // Set by the extension factory so sub-bindings can call pi.* APIs
  _api!: ExtensionAPI;
}

// ── External editor helper ─────────────────────────────────────────────────

async function openExternalEditor(editor: CtrlXEditor): Promise<void> {
  const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
  const currentText = editor.getText();

  // Write prompt to a temp file
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-edit-"));
  const tmpFile = join(tmpDir, "prompt.txt");
  await writeFile(tmpFile, currentText, "utf-8");

  try {
    // Spawn editor with stdio: 'inherit' so it takes over the terminal.
    // pi's TUI is suspended while the editor owns the terminal.
    await new Promise<void>((resolve, reject) => {
      const [cmd, ...args] = editorCmd.split(" ");
      const child = spawn(cmd, [...args, tmpFile], {
        stdio: "inherit",
        cwd: process.cwd(),
      });
      child.on("exit", (code) => {
        code === 0 ? resolve() : reject(new Error(`${editorCmd} exited ${code}`));
      });
      child.on("error", reject);
    });

    // Read back edited text
    const newText = await readFile(tmpFile, "utf-8");
    if (newText !== currentText) {
      editor.setText(newText);
    }
  } finally {
    await unlink(tmpFile).catch(() => {});
    await rmdir(tmpDir).catch(() => {});
  }
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      const editor = new CtrlXEditor(tui, theme, kb);
      editor._api = pi;
      return editor;
    });
  });
}
