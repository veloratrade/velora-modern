// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";

export function SecurityBand({ l }: { l: LandingI18n }) {
  const { t } = l;
  return (
    <>
      <div className="sec-band">
        {" "}
        <div className="wrap sec-grid grid-stagger">
          {" "}
          <div className="sec-item reveal">
            {" "}
            <svg fill="none" viewBox="0 0 24 24">
              <rect height="10" rx="2.5" stroke="#e9c45c" strokeWidth="1.7" width="16" x="4" y="10" />
              <path d="M8 10V7a4 4 0 018 0v3" stroke="#e9c45c" strokeWidth="1.7" />
              <circle cx="12" cy="15" fill="#e9c45c" r="1.8" />
            </svg>
            {" "}
            <div>
              <b>{t("common.aes.256.gcm.field.level.encryption.cd06962b")}</b>
              <span>{t("common.your.broker.data.is.never.stored.in.7a219817")}</span>
            </div>
            {" "}
          </div>
          {" "}
          <div className="sec-item reveal">
            {" "}
            <svg fill="none" viewBox="0 0 24 24">
              <path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z" stroke="#e9c45c" strokeLinejoin="round" strokeWidth="1.7" />
              <path d="M9 12l2 2 4-4" stroke="#e9c45c" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
            </svg>
            {" "}
            <div>
              <b>{t("common.hmac.webhook.verification.09e6b383")}</b>
              <span>{t("common.all.incoming.events.carry.a.cryptographic.signature.c3e700ec")}</span>
            </div>
            {" "}
          </div>
          {" "}
          <div className="sec-item reveal">
            {" "}
            <svg fill="none" viewBox="0 0 24 24">
              <path d="M4 18l5-6 4 3 7-9" stroke="#e9c45c" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
              <path d="M4 6h6M14 18h6" stroke="#e9c45c" strokeLinecap="round" strokeWidth="1.7" />
            </svg>
            {" "}
            <div>
              <b>{t("common.dual.jwt.rbac.40bb0860")}</b>
              <span>{t("common.role.based.access.control.with.secure.revocable.bd23fa5e")}</span>
            </div>
            {" "}
          </div>
          {" "}
          <div className="sec-item reveal">
            {" "}
            <svg fill="none" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" stroke="#e9c45c" strokeWidth="1.7" />
              <path d="M12 7v5l3.5 3.5" stroke="#e9c45c" strokeLinecap="round" strokeWidth="1.7" />
            </svg>
            {" "}
            <div>
              <b>{t("common.precision.financial.calculations.00ed3ed5")}</b>
              <span>{t("common.decimal.atomic.transactions.zero.rounding.errors.8a16be5a")}</span>
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </div>
    </>
  );
}
