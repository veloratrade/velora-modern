"use client";
import React from "react";
import { LogoGradientDefs } from "../../../components/brand/LogoMark";

export function AuthPageFrame({ page, children }: { page: "login" | "register"; children: React.ReactNode }) {
  return (
    <div className={`pg-${page}`}>
      <LogoGradientDefs />
      <div className="bg" aria-hidden="true" />
      <div className="noise" aria-hidden="true" />
      <div className="shell">{children}</div>
    </div>
  );
}
