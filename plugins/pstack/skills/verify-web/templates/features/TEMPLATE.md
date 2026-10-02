# Feature name

One paragraph on what the user can do here and what they see when it works. User's point of view only; no component or file names.

## Sub-features

- `feature-open` reaches the feature from each entry point.
- `feature-happy` completes the main action and shows the success state.
- `feature-cancel` abandons the action without side effects.
- `feature-empty` shows the empty or no-results state.
- `feature-error` surfaces a failure the user can understand.

## How to get to it (user POV)

- Choose the `Button label` control in the `Region name` area.
- Press `key` while focus is outside an editable field.
- Open the route `/<path>` directly.

## Driving it with control

Preconditions:

- `scripts/control doctor` passes.
- Seed state: describe it and how to create it.
- Nothing named `Fixture value` exists yet.

- **Open.** Choose `Button label`. Run `scripts/control click --role button --name "Button label" --shot`. A dialog named `Dialog name` appears with focus in the `Field` textbox.
- **Enter.** Type the value. Run `scripts/control fill --role textbox --name "Field" --value "Fixture value"`. The `Submit label` button becomes enabled.
- **Submit.** Choose `Submit label`. Run `scripts/control click --role button --name "Submit label" --shot`. A status named `Saved` appears.
- **Cross-check.** Confirm the side effect from a second read-only view. Run `scripts/control snapshot --role list --name "List name"` (and, when storage is involved, `scripts/control eval --js "…read-only read…"`). The new entry is present.
- **Proof.** Run `scripts/control screenshot --label feature-happy` and `scripts/control note --text "feature-happy via Button label"`. The artifacts show the app identity and the new entry.

## Gotchas

- Pressing `key` while a textbox has focus types the character instead of opening the feature.
- Results update after a debounce. `wait` on the result state, not a fixed sleep.
- Titles are trimmed on save. Assert the rendered value, not the draft input.
- A success status alone is insufficient proof. Reopen the entry from the list.
