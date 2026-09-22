/* Legacy minimal-page brand row: <a class="brand"><img src=/velora-logo.svg/><span>VELORA</span></a> */
import React from 'react';
import Link from 'next/link';

export function AuthBrand() {
  return (
    <Link className="brand" href="/">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="VELORA" src="/velora-logo.svg" />
      <span>VELORA</span>
    </Link>
  );
}
