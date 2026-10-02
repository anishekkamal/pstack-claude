# Create a note (example from the sample app)

Create note lets a user save a titled note from the editor dialog, cancel an unfinished draft, and confirm the saved note from the notes list and from storage. This entry was executed end to end against the sample app the harness was proven with; delete it once this repo has its own features.

## Sub-features

- `create-open` opens a blank editor from each entry point.
- `create-save` persists a title and body and shows the saved status.
- `create-cancel` discards an unfinished draft without side effects.

## How to get to it (user POV)

- Choose the `New note` button in the header.
- Press `n` while focus is outside an editable field.

## Driving it with control

Preconditions:

- `scripts/control doctor` passes with `markerFound: true`.
- No note titled `Release checklist` exists in the list.

- **Open editor.** Choose `New note`. Run `scripts/control click --role button --name "New note" --shot`. A dialog named `Note editor` appears with focus in the `Title` textbox.
- **Keyboard entry.** Close the dialog with `scripts/control press --key Escape`, then run `scripts/control press --key n`. The same dialog appears.
- **Enter content.** Run `scripts/control fill --role textbox --name "Title" --value "Release checklist"` and `scripts/control fill --role textbox --name "Body" --value "Tag and publish"`.
- **Save.** Run `scripts/control click --role button --name "Save note" --shot`. Then `scripts/control wait --role status`. `scripts/control text --selector "#status"` returns `Note saved`.
- **Cross-check list.** Run `scripts/control snapshot --role list --name "Notes list"`. The list contains `link "Release checklist"`.
- **Cross-check storage.** Run `scripts/control eval --js "JSON.parse(localStorage.getItem('notes')).map(n => n.t)"`. The array includes `Release checklist`.
- **Cancel draft.** Run `scripts/control click --role button --name "New note"`, `scripts/control fill --role textbox --name "Title" --value "Discard me"`, `scripts/control click --role button --name "Cancel"`. `scripts/control snapshot --role list --name "Notes list"` has no `Discard me` entry.
- **Proof.** Run `scripts/control note --text "create-save via New note button"` and `scripts/control verdict --claim "Saving a note adds it to the list and to storage" --result VERIFIED --evidence "snapshots list + localStorage read-back + shots" --reasoning "Real path driven; both views agree."`.

## Gotchas

- Pressing `n` while a textbox has focus types the character instead of opening the editor.
- Titles are trimmed on save; assert the rendered title.
- A modal dialog left open intercepts every later click; the error names it. Close it with its own control.
