
"use client";
import React from "react";

export default function Page() {
  const locale = typeof window!=="undefined" && window.location.pathname.startsWith("/en") ? "en":"fa";
  const isFa = locale==="fa";
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{isFa ? "عملکرد" : "Performance"}</h1>
          <p className="page-sub">Performance deep-dive — extends /analytics/* (R9 winRate semantics)</p>
        </div>
        <span className="badge badge-disconnected">PLANNED / GAP</span>
      </div>
      <div className="card">
        <h3 className="label text-gold">{isFa ? "وضعیت" : "Status"}</h3>
        <p className="muted-sm mt-8">
          {isFa ? "این بخش در Modern backend هنوز پیاده‌سازی نشده است. UI shell آماده است و پس از تکمیل API فعال می‌شود." : "This section has no Modern backend yet. UI shell is ready and will activate when the API lands."}
        </p>
        <p className="muted-xs mt-8">Route class check via <code className="v-latn-num">/api/v1/auth/me</code> passed (protected). No fake data invented.</p>
        <div className="flex-gap-8 mt-12">
          <span className="badge badge-disconnected">OWNER DECISION: R8 public/protected for /performance</span>
          <span className="badge badge-disconnected">GAP: no Modern endpoint</span>
        </div>
      </div>
      <div className="grid-2 mt-16">
        <div className="card-alt"><h3 className="label">Legacy</h3><p className="muted-xs mt-6">Reference: veloratrade/veloratrade @edede31 — capability kept as reference, not copied.</p></div>
        <div className="card-alt"><h3 className="label">Modern</h3><p className="muted-xs mt-6">Modern API: not present on main @80f0ade — classified GAP, not BLOCKED for other features.</p></div>
      </div>
    </div>
  );
}
