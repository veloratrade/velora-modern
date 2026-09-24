import React from "react";

export function InlineNotice({
  kind = "error",
  visible,
  children,
  id,
}: {
  kind?: "error" | "ok";
  visible: boolean;
  children?: React.ReactNode;
  id?: string;
}) {
  return <div id={id} className={`${kind === "ok" ? "ok-box" : "error-box"}${visible ? " show" : ""}`}>{children}</div>;
}
