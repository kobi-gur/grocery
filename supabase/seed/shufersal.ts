// One-off catalog seed from the Shufersal price-transparency PriceFull file.
// Creates the household from .env if needed, seeds the walk-order categories, upserts catalog_items.
// PriceFull has no department field, so the category is guessed from keywords in the item name.
//
//   node --env-file=.env supabase/seed/shufersal.ts            load into Supabase
//   node --env-file=.env supabase/seed/shufersal.ts --dry-run  print the category split, write nothing
//   STORE_ID=413 selects the branch (413 is שופרסל ONLINE)

import { gunzipSync } from "node:zlib";

const STORE_ID = process.env.STORE_ID ?? "413";
const PORTAL = "https://prices.shufersal.co.il/FileObject/UpdateCategory";
const BATCH_SIZE = 1000;
const DRY_RUN = process.argv.includes("--dry-run");

// Store-walk order of the categories.
const WALK_ORDER = [
  "פירות וירקות",
  "לחם ומאפים",
  "חלב וביצים",
  "בשר, עוף ודגים",
  "קפואים",
  "שימורים ורטבים",
  "אורז, פסטה וקטניות",
  "שמן, תבלינים ואפייה",
  "דגני בוקר",
  "חטיפים ומתוקים",
  "קפה ותה",
  "משקאות",
  "בעלי חיים",
  "תינוקות",
  "ניקיון ובית",
  "טיפוח ופארם",
  "אחר",
];
const OTHER = "אחר";

// Matches at the start of a word, so "מי" does not hit "קרמי". JS \b does not work on Hebrew.
const words = (...list: string[]) => new RegExp(`(?<!\\p{L})(?:${list.join("|")})`, "u");

// First hit wins. Non-food and sweets come first so "שמפו חלב" and "שוקולד חלב" do not land in dairy,
// and produce comes last because "יוגורט תות" and "רוטב עגבניות" name a fruit or vegetable too.
const RULES: [string, RegExp][] = [
  ["בעלי חיים", words("לכלב", "לחתול", "כלבים", "חתולים", "חול לחתול", "פנסי פיסט")],
  ["תינוקות", words("חיתול", "טיטול", "מטרנה", "סימילאק", "נוטרילון", "מוצץ", "מוצצ", "האגיס", "פמפרס", "הגיס", "מוסטלה", "בייבי", "לתינוק", "משחת החתלה")],
  ["טיפוח ופארם", words("שמפו", "מרכך לשיער", "מרכך שיער", "מסיכה", "מסכה", "מסכת", "סבון", "א\\.סבון", "אל סבון", "דאודורנט", "דאו\\.", "דאו ", "רול און", "משחת שיניים", "משחת ש", "קולגייט", "סנסודיין", "מברשת", "מברשות", "קרם", "תחליב", "בושם", "אדפ", "אדט", "איפור", "מייק", "מסקרה", "שפתון", "שפתיים", "עפרון", "עיפרון", "סומק", "גבות", "קונסילר", "פודרה", "גלוס", "צללית", "צלליות", "תוחם", "פריימר", "היילי?יט", "היילטר", "ברונזר", "פאונדיישן", "טינט", "טיינט", "לק", "ויטמין", "תוסף", "כמוסות", "תחבושת", "תחבושות", "טמפון", "קוטקס", "גילוח", "שיער", "לגבר", "לאשה", "לאישה", "יוניסקס", "מי פה", "סרום", "ניוואה", "דאב", "פלסטר", "עדשות", "מגן שמש", "הגנה", "טיפוח", "מסיר", "שעווה", "רחצה")],
  ["ניקיון ובית", words("אקונומיקה", "נוזל כלים", "נוזל רצפה", "נוזל", "טבליות למדיח", "מדיח", "כביסה", "מרכך כביסה", "ניקוי", "מנקה", "נייר", "מגבונים", "מגבו\\.", "שקיות", "שקית אשפה", "ניילון", "ספוג", "מטהר", "סוללות", "נר", "נרות", "צלחות", "כוסות", "סכו\"ם", "מפיות", "אלומיניום", "תבנית", "מארז כלים", "חד פעמי", "גביעי")],
  ["חטיפים ומתוקים", words("שוקולד", "ממתק", "סוכריות", "סוכ\\.", "מסטיק", "וופל", "עוגיות", "עוגיה", "חטיף", "חטיפי", "במבה", "ביסלי", "צ['׳]יפס", "קרקר", "פריכיות", "בייגלה", "פיצוחים", "גרעיני", "גרעינים", "אגוזי", "שקדים", "בוטנים", "תמרים", "פירות יבשים", "קינדר", "לינדט", "סניקרס", "מריר", "טופי", "מנטוס", "חלבה")],
  ["קפואים", words("קפוא", "קפואה", "קפואים", "גלידה", "גלידת", "גלטו", "שלגון", "ארטיק", "בצק עלים", "בלינצ", "פיצה", "אדממה", "נאגטס")],
  ["חלב וביצים", words("חלב", "גבינ", "גב\\.", "קוטג", "יוגורט", "שמנת", "קצפת", "חמאה", "מרגרינ", "לבן 3", "לבנה", "ביצים", "מעדן", "צפתית", "בולגרית", "מוצרלה", "פרמזן", "פתיתי עמק", "ריקוטה", "גאודה", "חלומי", "עיזים", "ברי", "דנונה", "מילקי", "מולר", "פרילי", "יופלה", "שוקו")],
  ["בשר, עוף ודגים", words("עוף", "הודו", "בקר", "בשר", "כבש", "טלה", "שניצל", "קציצ", "המבורגר", "נקניק", "פסטרמה", "סלמי", "פפרוני", "סלמון", "דג", "דגים", "אמנון", "לברק", "דניס", "נילוס", "קבב", "חזה", "שוקי", "שוקיים", "כנפיים", "כנף", "כרעי", "פרגית", "ספייר", "קרפצ", "שריר", "כתף", "טחון בקר")],
  ["לחם ומאפים", words("לחם", "לחמני", "פיתה", "פיתות", "חלה", "חלות", "באגט", "טורטיה", "לאפה", "מאפה", "מאפין", "בורקס", "קרואסון", "עוגה", "עוגת", "רוגלך", "פרוס")],
  ["קפה ותה", words("קפה", "נס קפה", "תה", "קפסולות", "פולי קפה", "חליטה", "חליטת", "תיון")],
  ["משקאות", words("מים", "מי", "סודה", "קולה", "קוקה", "ספרייט", "פאנטה", "שוופס", "מיץ", "משקה", "בירה", "יין", "וודקה", "ויסקי", "ליקר", "שתיה", "נקטר", "לימונדה", "פריגת", "תפוזינה", "פריגת", "סירופ", "קברנה", "מרלו", "שרדונה", "מוגז", "פרוט ווטר", "750 ?מ")],
  ["דגני בוקר", words("דגני", "קורנפלקס", "גרנולה", "שיבולת", "מוזלי", "קוואקר")],
  ["אורז, פסטה וקטניות", words("אורז", "פסטה", "ספגטי", "פתיתים", "קוסקוס", "קינואה", "עדשים", "שעועית", "גרגירי", "אטריות", "נודלס", "בורגול", "פירורי לחם", "פנקו", "מרק", "אבקת מרק", "קובה")],
  ["שמן, תבלינים ואפייה", words("שמן", "חומץ", "מלח", "סוכר", "קמח", "שמרים", "אבקת אפיה", "תבלין", "תיבול", "פפריקה", "כמון", "פלפל שחור", "פלפל לבן", "כורכום", "קינמון", "וניל", "קקאו", "תמצית", "ציפוי", "סודה לשתיה", "ממתיק", "זרעי")],
  ["שימורים ורטבים", words("שימור", "רסק", "רוטב", "קטשופ", "מיונז", "חרדל", "טחינה", "חומוס", "סלט", "זיתים", "זית", "מלפפון בחומץ", "מלפפונים חמוצים", "חמוצים", "תירס", "טונה", "סרדינ", "ממרח", "ריבה", "ריבת", "דבש", "סילאן", "חמאת בוטנים", "אנשובי", "קונפיטורה", "גרעיני תירס")],
  ["פירות וירקות", words("עגבני", "מלפפון", "פלפל", "בצל", "שום", "גזר", "תפו\"?א", "תפוח", "תפוחי", "אגס", "בננ", "ענב", "אבטיח", "מלון", "תות", "אבוקדו", "לימון", "תפוז", "קלמנטינ", "אשכולית", "מנגו", "אפרסק", "נקטרינ", "שזיף", "רימון", "קיווי", "אננס", "חסה", "כרוב", "ברוקולי", "כרובית", "קישוא", "חציל", "דלעת", "סלרי", "פטרוזיליה", "כוסבר", "שמיר", "נענע", "בטטה", "סלק", "צנון", "פטריות", "ירק", "פירות")],
];

function guessCategory(name: string): string {
  for (const [category, rule] of RULES) if (rule.test(name)) return category;
  return OTHER;
}

const decodeXml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]).trim() : "";
};

async function downloadPriceFull(storeId: string): Promise<{ file: string; xml: string }> {
  const page = await fetch(`${PORTAL}?catID=2&storeId=${storeId}`);
  if (!page.ok) throw new Error(`portal returned ${page.status}`);
  const html = await page.text();
  const link = html.match(/https?:\/\/[^"]*PriceFull[^"]*/)?.[0]?.replaceAll("&amp;", "&");
  if (!link) throw new Error(`no PriceFull file listed for store ${storeId}`);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`download returned ${res.status}`);
  const file = new URL(link).pathname.split("/").pop() ?? "";
  return { file, xml: gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8") };
}

type ParsedItem = { barcode: string; name_he: string; category: string; default_unit: "kg" | "unit" };

function parseItems(xml: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const m of xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
    const barcode = tag(m[1], "ItemCode");
    const name_he = tag(m[1], "ItemName").replace(/\s+/g, " ");
    if (!barcode || !name_he) continue;
    items.push({
      barcode,
      name_he,
      category: guessCategory(name_he),
      default_unit: tag(m[1], "bIsWeighted") === "1" ? "kg" : "unit",
    });
  }
  return items;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name} in .env`);
  return value;
}

async function main() {
  console.log(`store ${STORE_ID}: downloading PriceFull`);
  const { file, xml } = await downloadPriceFull(STORE_ID);
  const items = parseItems(xml);
  console.log(`${file}: ${items.length} items parsed`);

  const split = new Map<string, number>();
  for (const item of items) split.set(item.category, (split.get(item.category) ?? 0) + 1);
  for (const [category, count] of [...split].sort((a, b) => b[1] - a[1])) console.log(`  ${category}: ${count}`);
  if (DRY_RUN) return;

  // Accept SUPABASE_URL with or without a trailing /rest/v1/ path.
  const base = new URL(requireEnv("SUPABASE_URL")).origin;
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const rest = async (path: string, body: unknown, prefer: string) => {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: prefer },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res;
  };
  const merge = "resolution=merge-duplicates,return=representation";

  const [household] = await (await rest(
    "households?on_conflict=code&select=id",
    [{ code: requireEnv("HOUSEHOLD_CODE"), wifey_phone: requireEnv("WIFEY_PHONE_E164") }],
    merge,
  )).json();

  const categoryRows: { id: string; name_he: string }[] = await (await rest(
    "categories?on_conflict=household_id,name_he&select=id,name_he",
    WALK_ORDER.map((name_he, i) => ({ household_id: household.id, name_he, sort_order: (i + 1) * 10 })),
    merge,
  )).json();
  const categoryId = new Map(categoryRows.map((c) => [c.name_he, c.id]));

  // Only chain-owned columns are sent, so a re-run keeps stars and purchase counts.
  let landed = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const rows = items.slice(i, i + BATCH_SIZE).map((item) => ({
      household_id: household.id,
      barcode: item.barcode,
      name_he: item.name_he,
      category_id: categoryId.get(item.category),
      default_unit: item.default_unit,
      source: "chain",
    }));
    await rest("catalog_items?on_conflict=household_id,barcode", rows, "resolution=merge-duplicates,return=minimal");
    landed += rows.length;
    console.log(`upserted ${landed}/${items.length}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
