import { Fragment, type ReactNode } from "react";
import { splitDigitRuns } from "./latinDigits";

/** Renders text with Legacy-equivalent digit isolation (server or client). */
export function latinNodes(value: string): ReactNode {
  const segments = splitDigitRuns(value);
  if (segments.length === 1 && !segments[0]!.digits) return segments[0]!.text;
  return segments.map((s, i) =>
    s.digits ? (
      <span key={i} className="v-latn-num" lang="en" dir="ltr">
        {s.text}
      </span>
    ) : (
      <Fragment key={i}>{s.text}</Fragment>
    ),
  );
}
