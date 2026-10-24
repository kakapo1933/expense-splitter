import type { KeyboardEvent } from "react";

/**
 * True when this keydown is the Enter that confirms an IME composition
 * (Chinese/Japanese/Korean input methods). Browsers report it as a normal
 * "Enter" keydown, so without this check the field would submit the
 * half-composed text and then receive the committed text again.
 * `keyCode === 229` covers browsers that fire the event after compositionend
 * without setting `isComposing`.
 */
export function isComposingEnter(e: KeyboardEvent<HTMLElement>): boolean {
  return e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229);
}
