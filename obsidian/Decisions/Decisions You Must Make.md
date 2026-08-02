# Decisions only you can make

Code can be rewritten in a week. These cannot. Work through them in order — each one changes
the database schema or the business model, and both get expensive to change after launch.

---

## 1. The cold-start problem: which side do you fill first?

A marketplace with no agencies is useless to travelers; with no travelers it's useless to agencies.
You cannot launch both at once.

**The standard answer that works:** fill the supply side manually, by hand, unscalably.
Recruit 20–40 real agencies in Alger and Oran. Build their offer pages *for* them from the
Facebook posts they already publish. They do nothing but answer the phone when a lead arrives.
Then spend everything on demand.

**Your decision:** are you willing to do 40 in-person/phone agency sign-ups yourself?
If not, the product doesn't matter — pick a different business.

---

## 2. Your wedge — do NOT launch "all travel"

"Marketplace for voyages" is too broad to rank on Google, too broad to explain, too broad to seed.

Candidate wedges, ranked by how well they fit Algeria:

| Wedge | Ticket size | Volume | Emotion / trust need | Seasonality |
|---|---|---|---|---|
| **Omra** | High | Very high | Extreme | Year-round, peaks Ramadan |
| Hajj | Very high | Regulated/quota | Extreme | Once yearly |
| Turkey / Dubai / Tunisia packages | Medium | High | Medium | Summer |
| Schengen visa assistance | Low | Very high | High | Year-round |

Omra is the strongest wedge: high ticket, high volume, and buyers are *terrified* of fraud —
which means verification (see #4) is worth real money to them. You own one category, then expand.

**Your decision:** which single category is v1? Everything else is a filter you add in month 6.

---

## 3. What you are actually selling — and the legal line under it

You wrote "selling information of high ticket clients." Read this carefully, because there are
two versions of that sentence and only one of them is a business.

**Version A (do not build):** collect traveler data, then sell that list to whoever pays.
Under Algeria's Law 18-07 on personal data protection, processing personal data requires informed
consent and a defined purpose; selling it on is a different purpose. You would also be one
screenshot away from destroying the trust the whole product depends on.

**Version B (this is the actual business, and it's bigger):** the traveler submits an inquiry for
a specific trip and *explicitly consents* to being contacted by matching verified agencies.
You charge agencies for the introduction. Nobody's data is sold — a warm, consented, intent-rich
lead is delivered. Emploitic, Indeed, and every insurance comparator work exactly this way.

Version B is worth more per lead than Version A, and it's defensible.

**Your decision:** commit to Version B, and design the consent checkbox and its audit trail into
the inquiry form from day one. Get an Algerian lawyer to review the privacy policy before you
take the first dinar. (I will not invent what the law requires — verify it.)

---

## 4. Trust is the product, not a feature

Algerians have watched agencies take Omra money and disappear. That fear is your entire opening.

Anyone can build a listings site. What's hard, slow, and defensible is being the place where
**every agency is verified**: registre de commerce, the tourism ministry licence
(*agrément d'agence de tourisme et de voyage*), a real address someone visited, a bank account
in the company's name.

Do this manually, for every single agency, forever. Put a verification badge on it. Say publicly
what the badge means. Refuse agencies that fail — the refusals are what make the badge worth
anything.

**Your decision:** what exactly does "Vérifiée" mean on your site, in one sentence a traveler
believes? Write that sentence before writing any code.

---

## 5. How agencies pay you — in a country without Stripe

Card penetration is low. Stripe doesn't operate in Algeria. Your options are a local PSP for
CIB/Edahabia cards, and CCP / BaridiMob transfers confirmed manually by your admin.

That constraint pushes you toward a **monthly subscription** (one payment, easy to reconcile
by hand) rather than **per-lead billing** (many tiny payments, impossible to reconcile by hand
at first).

But per-lead aligns incentives better and is far easier to sell to a skeptical agency owner:
"pay only when we send you a real client."

Realistic path: **prepaid credit balance.** The agency transfers 10,000 DZD, you confirm it once,
their balance loads, each delivered lead deducts credits. One manual reconciliation, per-lead
economics, and it works entirely on rails that exist in Algeria today.

**Your decision:** subscription, per-lead, or prepaid credits. This shapes the billing schema —
but v1 ships with **zero billing code**, only the ledger tables that make it possible later.

---

## 6. Who owns the traveler relationship?

If the phone number is visible on the listing, the agency and traveler talk off-platform and you
are invisible — and unpaid. If you hide it entirely, low-tech agencies churn because "it's easier
on WhatsApp."

The workable middle: the inquiry always creates a lead *in your system first*, then the agency
gets the contact details. You still measured it, you still own the record, and you can prove
value at renewal: "we sent you 47 leads this month."

**Your decision:** are contact details revealed immediately, or after the agency responds
in-platform? This determines whether you can ever charge.

---

## 7. Language

Arabic + French, both, from day one — and Arabic means RTL, which is an architectural decision,
not a translation task. Retrofitting RTL into a finished UI costs more than building it in.

**Your decision:** which is the default language on first visit?

---

## 8. What v1 deliberately does NOT do

Saying no is the design. v1 has **no** online booking, **no** payments, **no** reviews,
**no** in-app chat, **no** AI chatbot.

Why: booking requires trust you haven't earned; reviews need volume you don't have; chat competes
with WhatsApp and loses. The AI chatbot is a premium feature you sell in year two — it needs your
own data to be any good, and you have none yet.

v1 does exactly one thing well: **a traveler finds a verified offer and the right agency gets
a lead they can work.** Everything else is a distraction until that loop spins.
