// Roadmap-schema verification harness — migrations 0015..0022.
//
// Runs the REAL migration files against a DISPOSABLE PGlite instance and asserts the
// roadmap-specified schema contract, including 40+ NEGATIVE assertions (cross-owner
// rows, illegal MIME/oversize attachments, a second live subscription, consent-less
// transcripts, nonce reuse, scope escalation, …).
//
// Run:  npx tsx db/tests/roadmapSchemaVerification.pglite.ts
// Exit: 0 = all assertions passed, 1 = at least one failed (suitable for CI).
// Deliberately NOT named *.test.ts / *.pg.test.ts so the repo test discovery
// (tools/run-tests.mjs) does not pick it up automatically; the migration chain
// itself is covered by `npm run test:migrations`.
//
// Dev/test evidence only — PGlite ≈ PostgreSQL 16 semantics in wasm, NOT
// production hosting evidence (same caveat as db/tests/migrations.test.ts).
import { join } from "node:path";
import { createEngine, migrate, type MigrationEngine } from "../migrate.ts";
const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const engine = await createEngine();
let pass = 0, fail = 0;
const ok = (n: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${n}`); }
  else { fail++; console.log(`FAIL  ${n} ${detail}`); }
};
const rejects = async (n: string, sql: string, params: unknown[]) => {
  try { await engine.query(sql, params); fail++; console.log(`FAIL  ${n} — statement was ACCEPTED but should be rejected`); }
  catch (e) { pass++; console.log(`PASS  ${n}  [${(e as Error).message.split("\n")[0].slice(0, 68)}]`); }
};
const accepts = async (n: string, sql: string, params: unknown[] = []) => {
  try { await engine.query(sql, params); pass++; console.log(`PASS  ${n}`); }
  catch (e) { fail++; console.log(`FAIL  ${n} — rejected: ${(e as Error).message.split("\n")[0]}`); }
};

try {
  const applied = await migrate(engine, MIGRATIONS);
  console.log(`applied: ${applied.length} files, head=${applied[applied.length - 1]}`);
  const second = await migrate(engine, MIGRATIONS);
  ok("re-running the chain applies nothing (idempotent)", second.length === 0, `ran=${second.join(",")}`);

  // --- fixtures -----------------------------------------------------------
  const uA = String((await engine.query("INSERT INTO users(email,password_hash) VALUES('a@x.ir','h') RETURNING id")).rows[0]!.id);
  const uB = String((await engine.query("INSERT INTO users(email,password_hash) VALUES('b@x.ir','h') RETURNING id")).rows[0]!.id);
  const acctA = String((await engine.query("INSERT INTO trading_accounts(user_id, external_account_id, metaapi_account_id) VALUES($1,'AA-1','mp-acc-a') RETURNING id", [uA])).rows[0]!.id);
  const acctB = String((await engine.query("INSERT INTO trading_accounts(user_id, external_account_id) VALUES($1,'BB-1') RETURNING id", [uB])).rows[0]!.id);
  const trA = String((await engine.query(`INSERT INTO trades(user_id,account_id,symbol,direction,entry_price,volume,occurred_at)
      VALUES($1,$2,'XAUUSD','buy',2350.5,1.0, now()) RETURNING id`, [uA, acctA])).rows[0]!.id);
  const trB = String((await engine.query(`INSERT INTO trades(user_id,account_id,symbol,direction,entry_price,volume,occurred_at)
      VALUES($1,$2,'EURUSD','sell',1.08,1.0, now()) RETURNING id`, [uB, acctB])).rows[0]!.id);

  // --- 0015 tags ----------------------------------------------------------
  const tagA = String((await engine.query("INSERT INTO tags(user_id,name,kind) VALUES($1,'Fair Value Gap','SETUP') RETURNING id", [uA])).rows[0]!.id);
  await accepts("0015 tags: owner's own tag attaches to own trade", "INSERT INTO trade_tags(trade_id,tag_id,user_id) VALUES($1,$2,$3)", [trA, tagA, uA]);
  await rejects("0015 tags: CROSS-OWNER tag attach is refused by the DB",
    "INSERT INTO trade_tags(trade_id,tag_id,user_id) VALUES($1,$2,$3)", [trB, tagA, uB]);
  await rejects("0015 tags: mismatched user_id on the association row is refused",
    "INSERT INTO trade_tags(trade_id,tag_id,user_id) VALUES($1,$2,$3)", [trA, tagA, uB]);
  await rejects("0015 tags: duplicate tag name per user refused",
    "INSERT INTO tags(user_id,name) VALUES($1,'Fair Value Gap')", [uA]);
  await rejects("0015 tags: colour must be #rrggbb", "INSERT INTO tags(user_id,name,color) VALUES($1,'x','red')", [uA]);
  await rejects("0015 tags: empty name refused", "INSERT INTO tags(user_id,name) VALUES($1,'   ')", [uA]);

  // --- 0015 attachments ---------------------------------------------------
  const at = "INSERT INTO trade_attachments(trade_id,user_id,file_name,mime,size_bytes,storage_key) VALUES($1,$2,$3,$4,$5,$6)";
  await accepts("0015 attachments: jpeg within limits accepted", at, [trA, uA, "c1.jpg", "image/jpeg", 1024, "obj/c1.jpg"]);
  await rejects("0015 attachments: mime outside the roadmap whitelist refused", at, [trA, uA, "x.gif", "image/gif", 10, "obj/x.gif"]);
  await rejects("0015 attachments: >5MB refused", at, [trA, uA, "big.jpg", "image/jpeg", 5242881, "obj/big.jpg"]);
  await rejects("0015 attachments: zero-byte refused", at, [trA, uA, "z.jpg", "image/jpeg", 0, "obj/z.jpg"]);
  await rejects("0015 attachments: duplicate storage key refused", at, [trA, uA, "c2.jpg", "image/png", 10, "obj/c1.jpg"]);
  await rejects("0015 attachments: cross-owner attach refused", at, [trB, uA, "y.jpg", "image/jpeg", 10, "obj/y.jpg"]);

  // --- 0016 analytics -----------------------------------------------------
  const a1 = "INSERT INTO user_analytics_daily(user_id,day,tz_basis,tz_basis_source,trades_count,wins,losses,breakeven,net_pnl) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)";
  await accepts("0016 analytics: a (day, zone) row is accepted", a1, [uA, "2026-03-12", "Asia/Tehran", "assumed_utc", 3, 2, 1, 0, "12.34"]);
  await accepts("0016 analytics: the SAME day under a different basis coexists (no silent UTC assumption)",
    a1, [uA, "2026-03-12", "UTC", "assumed_utc", 3, 2, 1, 0, "12.34"]);
  await rejects("0016 analytics: duplicate (user, day, basis) refused", a1, [uA, "2026-03-12", "UTC", "assumed_utc", 1, 0, 0, 0, "0.00"]);
  await rejects("0016 analytics: partitions may not exceed the trade count", a1, [uA, "2026-03-13", "UTC", "unknown", 2, 2, 2, 0, "0.00"]);
  await rejects("0016 analytics: unknown basis source refused", a1, [uA, "2026-03-14", "UTC", "guessed", 1, 0, 0, 0, "0.00"]);
  await rejects("0016 analytics: negative gross profit refused",
    "INSERT INTO account_performance_summary(account_id,user_id,gross_profit) VALUES($1,$2,-1)", [acctA, uA]);
  await accepts("0016 analytics: account summary accepted", "INSERT INTO account_performance_summary(account_id,user_id,net_pnl) VALUES($1,$2,'10.00')", [acctA, uA]);

  // --- 0017 billing -------------------------------------------------------
  await accepts("0017 plan: 'pro' accepted", "UPDATE users SET plan='pro' WHERE id=$1", [uA]);
  await rejects("0017 plan: unknown tier refused", "UPDATE users SET plan='gold' WHERE id=$1", [uA]);
  const sub = "INSERT INTO subscriptions(user_id,plan,status,provider_subscription_id) VALUES($1,'pro',$2,$3)";
  await accepts("0017 subscriptions: active row accepted", sub, [uA, "active", "sub_1"]);
  await rejects("0017 subscriptions: a SECOND live subscription for one user is refused", sub, [uA, "trialing", "sub_2"]);
  await accepts("0017 subscriptions: a non-live row may coexist", sub, [uA, "canceled", "sub_3"]);
  await rejects("0017 subscriptions: duplicate provider subscription id refused", sub, [uB, "active", "sub_1"]);
  await rejects("0017 subscriptions: unknown status refused", sub, [uB, "active", "sub_9"].map((v, i) => i === 1 ? "paused" : v));
  const ai = "INSERT INTO ai_coaching_logs(user_id,provider,model,prompt_version,insight,outcome) VALUES($1,'openai','gpt-x','v1',$2,'success')";
  await accepts("0017 ai coach: object insight accepted", ai, [uA, JSON.stringify({ leaks: [] })]);
  await rejects("0017 ai coach: non-object insight refused", ai, [uA, JSON.stringify([1, 2])]);
  await rejects("0017 ai coach: unknown provider refused", "INSERT INTO ai_coaching_logs(user_id,provider,model,prompt_version,insight,outcome) VALUES($1,'anthropic','m','v1','{}','success')", [uA]);

  // --- 0018 portfolio / prop ---------------------------------------------
  await accepts("0018 fx: valid rate accepted", "INSERT INTO currency_rates(base,quote,rate_date,rate) VALUES('EUR','USD','2026-09-22',1.0812345678)");
  await rejects("0018 fx: non-positive rate refused", "INSERT INTO currency_rates(base,quote,rate_date,rate) VALUES('GBP','USD','2026-09-22',0)");
  await rejects("0018 fx: identical pair refused", "INSERT INTO currency_rates(base,quote,rate_date,rate) VALUES('USD','USD','2026-09-22',1)");
  await rejects("0018 fx: lowercase code refused", "INSERT INTO currency_rates(base,quote,rate_date,rate) VALUES('eur','USD','2026-09-22',1)");
  const grp = String((await engine.query("INSERT INTO account_groups(user_id,name) VALUES($1,'Prop') RETURNING id", [uA])).rows[0]!.id);
  await accepts("0018 groups: owner groups own account", "INSERT INTO account_group_members(group_id,account_id,user_id) VALUES($1,$2,$3)", [grp, acctA, uA]);
  await rejects("0018 groups: grouping ANOTHER user's account refused", "INSERT INTO account_group_members(group_id,account_id,user_id) VALUES($1,$2,$3)", [grp, acctB, uA]);
  await rejects("0018 groups: duplicate group name per user refused", "INSERT INTO account_groups(user_id,name) VALUES($1,'Prop')", [uA]);
  const pf = "INSERT INTO prop_firm_rules(account_id,user_id,rule_set_name,max_daily_drawdown,drawdown_basis,alert_threshold_pct) VALUES($1,$2,$3,$4,$5,$6)";
  await accepts("0018 prop: rule set accepted", pf, [acctA, uA, "FTMO-100k", "5000.00", "equity", 80]);
  await rejects("0018 prop: a SECOND enabled rule for the same account refused", pf, [acctA, uA, "other", "1000.00", "balance", 50]);
  await rejects("0018 prop: threshold above 100% refused", pf, [acctB, uB, "x", "1000.00", "balance", 101]);
  await rejects("0018 prop: unknown drawdown basis refused", pf, [acctB, uB, "x", "1000.00", "peak", 80]);

  // --- 0019 EA + push -----------------------------------------------------
  const h = "a".repeat(64);
  await accepts("0019 ea: 64-hex key hash accepted", "UPDATE trading_accounts SET ea_api_key_hash=$1, ea_key_created_at=now() WHERE id=$2", [h, acctA]);
  await rejects("0019 ea: short hash refused", "UPDATE trading_accounts SET ea_api_key_hash='abc' WHERE id=$1", [acctB]);
  await rejects("0019 ea: duplicate key hash refused", "UPDATE trading_accounts SET ea_api_key_hash=$1 WHERE id=$2", [h, acctB]);
  const dt = "INSERT INTO device_tokens(user_id,platform,token_fingerprint,key_version,iv,auth_tag,token_ciphertext) VALUES($1,'ios',$2,1,$3,$4,$5)";
  const iv = Buffer.alloc(12, 1), tag = Buffer.alloc(16, 2), ct = Buffer.from("cipher");
  await accepts("0019 push: well-formed envelope accepted", dt, [uA, "f".repeat(64), iv, tag, ct]);
  await rejects("0019 push: duplicate fingerprint refused", dt, [uA, "f".repeat(64), Buffer.alloc(12, 9), tag, ct]);
  await rejects("0019 push: non-12-byte IV refused", dt, [uA, "e".repeat(64), Buffer.alloc(11, 1), tag, ct]);
  await rejects("0019 push: reused (key_version, iv) refused", dt, [uA, "d".repeat(64), iv, tag, ct]);
  await rejects("0019 push: unknown platform refused", dt, [uA, "c".repeat(64), Buffer.alloc(12, 3), tag, ct].map((v, i) => i === 1 ? "symbian" : v));

  // --- 0020 tenancy / social / copy --------------------------------------
  await accepts("0020 tenants: valid slug accepted", "INSERT INTO tenants(slug,display_name) VALUES('propfirm-x','Prop Firm X')");
  await rejects("0020 tenants: uppercase slug refused", "INSERT INTO tenants(slug,display_name) VALUES('PropFirm','P')");
  await accepts("0020 profiles: private profile accepted", "INSERT INTO public_profiles(user_id,handle) VALUES($1,'trader-a')", [uA]);
  const abs = (await engine.query("SELECT show_absolute_amounts AS v FROM public_profiles WHERE user_id=$1", [uA])).rows[0]!.v;
  ok("0020 profiles: absolute amounts default to FALSE (roadmap leak rule)", abs === false, String(abs));
  await rejects("0020 profiles: verification cannot exist without a proof hash",
    "UPDATE public_profiles SET verified_at=now() WHERE user_id=$1", [uA]);
  await accepts("0020 profiles: verified + hash accepted", "UPDATE public_profiles SET verified_at=now(), verification_hash=$2 WHERE user_id=$1", [uA, "b".repeat(64)]);
  await rejects("0020 profiles: duplicate handle refused", "INSERT INTO public_profiles(user_id,handle) VALUES($1,'trader-a')", [uB]);
  const cr = "INSERT INTO copy_relationships(leader_user_id,follower_user_id,leader_account_id,follower_account_id) VALUES($1,$2,$3,$4)";
  await accepts("0020 copy: valid relationship accepted", cr, [uA, uB, acctA, acctB]);
  await rejects("0020 copy: self-copy refused", cr, [uA, uA, acctA, acctA]);
  await rejects("0020 copy: duplicate live pair refused", cr, [uA, uB, acctA, acctB]);
  await rejects("0020 copy: leader account not owned by the leader refused", cr, [uA, uB, acctB, acctB]);
  const sq = "INSERT INTO signal_queue(leader_account_id,leader_user_id,symbol,direction,volume,price,occurred_at,status,acked_at) VALUES($1,$2,'XAUUSD','buy',1.0,2400.0,now(),$3,$4)";
  await accepts("0020 signals: queued signal accepted", sq, [acctA, uA, "queued", null]);
  await rejects("0020 signals: zero volume refused",
    "INSERT INTO signal_queue(leader_account_id,leader_user_id,symbol,direction,volume,price,occurred_at) VALUES($1,$2,'XAUUSD','buy',$3,2400.0,now())",
    [acctA, uA, 0]);
  await rejects("0020 signals: 'acked' without an ack instant refused", sq, [acctA, uA, "acked", null]);
  await accepts("0020 signals: 'acked' with an ack instant accepted", sq, [acctA, uA, "acked", new Date().toISOString()]);

  // --- 0021 developer api / ml / voice -----------------------------------
  const dk = "INSERT INTO developer_api_keys(user_id,name,key_prefix,key_hash,scopes) VALUES($1,$2,$3,$4,$5)";
  await accepts("0021 api keys: default scope accepted", dk, [uA, "k1", "vk123456", h, ["trades:read"]]);
  await rejects("0021 api keys: duplicate hash refused", dk, [uA, "k2", "vk654321", h, ["trades:read"]]);
  await rejects("0021 api keys: scope outside the vocabulary refused", dk, [uA, "k3", "vk111111", "1".repeat(64), ["admin:*"]]);
  await rejects("0021 api keys: rate limit above the cap refused", "INSERT INTO developer_api_keys(user_id,name,key_prefix,key_hash,rate_limit_per_min) VALUES($1,'k4','vk222222',$2,99999)", [uA, "2".repeat(64)]);
  const ml = "INSERT INTO ml_model_predictions(user_id,model_name,model_version,features,prediction,probability) VALUES($1,'m','1','{}','{}',$2)";
  await accepts("0021 ml: probability 0.65 accepted", ml, [uA, 0.65]);
  await rejects("0021 ml: probability above 1 refused", ml, [uA, 1.5]);
  await rejects("0021 ml: non-object features refused", "INSERT INTO ml_model_predictions(user_id,model_name,model_version,features,prediction) VALUES($1,'m','1','[]','{}')", [uA]);
  const vs = "INSERT INTO voice_session_logs(user_id,session_uid,started_at,transcript_retained,transcript) VALUES($1,$2,now(),$3,$4)";
  await accepts("0021 voice: metadata-only session accepted", vs, [uA, "sess-00000001", false, null]);
  await rejects("0021 voice: transcript WITHOUT consent refused", vs, [uA, "sess-00000002", false, "secret words"]);
  await accepts("0021 voice: transcript WITH consent accepted", vs, [uA, "sess-00000003", true, "consented words"]);
  await rejects("0021 voice: duplicate session uid refused", vs, [uA, "sess-00000001", false, null]);

  // --- schema-level assertions -------------------------------------------
  const t = String((await engine.query("SELECT count(*) AS c FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tags','trade_tags','trade_attachments','user_analytics_daily','account_performance_summary','subscriptions','ai_coaching_logs','currency_rates','account_groups','account_group_members','prop_firm_rules','device_tokens','tenants','public_profiles','copy_relationships','signal_queue','developer_api_keys','ml_model_predictions','voice_session_logs')")).rows[0]!.c);
  ok("schema: all 19 roadmap tables exist", String(t) === "19", `found=${t}`);
  const idx = (await engine.query("SELECT count(*) AS c FROM pg_indexes WHERE schemaname='public' AND indexname IN ('trades_account_open_canonical_idx','trades_account_symbol_idx','trading_accounts_ea_key_unique','subscriptions_one_live_per_user')")).rows[0]!.c;
  ok("schema: roadmap composite/partial indexes exist", String(idx) === "4", `found=${idx}`);
  const noPlain = (await engine.query(`SELECT count(*) AS c FROM information_schema.columns WHERE table_schema='public'
     AND column_name IN ('ea_api_key','api_key','push_token','transcript_audio','stripe_secret')`)).rows[0]!.c;
  ok("schema: no plaintext key/token/audio column exists", String(noPlain) === "0", `found=${noPlain}`);
} catch (e) {
  console.log("HARNESS ERROR:", (e as Error).message);
  fail++;
} finally {
  console.log(`\nRESULT: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
  await engine.close();
}
