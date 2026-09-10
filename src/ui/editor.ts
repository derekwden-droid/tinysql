import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, SQLite } from "@codemirror/lang-sql";
import { lineNumbers, highlightActiveLineGutter, drawSelection, highlightActiveLine } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Underline the token an error points at, so the message has a target. */
const setErrorRange = StateEffect.define<{ from: number; to: number } | null>();

const errorMark = Decoration.mark({ class: "cm-error-token" });

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setErrorRange)) {
        next =
          effect.value === null
            ? Decoration.none
            : Decoration.set([errorMark.range(effect.value.from, effect.value.to)]);
      }
    }
    // Any edit clears the marker: the position is stale the moment you type.
    if (tr.docChanged) next = Decoration.none;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "13px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
    ".cm-content": { padding: "8px 0", caretColor: "var(--accent)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "#555c6a",
      border: "none",
      paddingRight: "4px",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(122,162,255,0.25)",
    },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#7aa2ff", fontWeight: "500" },
  { tag: tags.string, color: "#3dd68c" },
  { tag: tags.number, color: "#e6b450" },
  { tag: tags.bool, color: "#e6b450" },
  { tag: tags.null, color: "#e6b450" },
  { tag: tags.comment, color: "#5f6673", fontStyle: "italic" },
  { tag: tags.operator, color: "#c8cede" },
  { tag: tags.punctuation, color: "#8b93a1" },
  { tag: tags.typeName, color: "#8fd0c4" },
  { tag: tags.variableName, color: "#e8eaef" },
  { tag: tags.propertyName, color: "#e8eaef" },
]);

export interface EditorHandle {
  getValue(): string;
  setValue(text: string): void;
  focus(): void;
  /** Underline the token at a 1-based line/column. */
  markError(line: number, column: number): void;
  clearError(): void;
}

const IDENT = /[A-Za-z0-9_]/;

/** Widen a caret position into the token it sits on, so the underline is visible. */
function tokenRange(doc: string, offset: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(offset, Math.max(doc.length - 1, 0)));
  if (doc.length === 0) return { from: 0, to: 0 };
  let to = from;
  while (to < doc.length && IDENT.test(doc[to]!)) to++;
  if (to === from) to = Math.min(from + 1, doc.length);
  return { from, to };
}

export interface EditorOptions {
  initialDoc: string;
  onRun: () => void;
  onExplain: () => void;
  onChange: (doc: string) => void;
}

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.initialDoc,
      extensions: [
        // Listed first so Mod-Enter wins over the default keymap's newline.
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              options.onRun();
              return true;
            },
          },
          {
            key: "Shift-Mod-Enter",
            preventDefault: true,
            run: () => {
              options.onExplain();
              return true;
            },
          },
        ]),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        sql({ dialect: SQLite, upperCaseKeywords: true }),
        syntaxHighlighting(highlight),
        errorField,
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
      view.focus();
    },
    focus: () => view.focus(),
    markError(line, column) {
      const doc = view.state.doc;
      const safeLine = Math.max(1, Math.min(line, doc.lines));
      const lineInfo = doc.line(safeLine);
      const offset = Math.min(lineInfo.from + Math.max(0, column - 1), lineInfo.to);
      const range = tokenRange(doc.toString(), offset);
      view.dispatch({ effects: setErrorRange.of(range) });
    },
    clearError() {
      view.dispatch({ effects: setErrorRange.of(null) });
    },
  };
}
