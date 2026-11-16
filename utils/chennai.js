// utils/chennai.js
// Chennai-only restriction for bus routes (public read side). Mirror of the
// admin backend's utils/chennai.js. A route is shown only when its start, end
// and every stop are within Chennai.

const OUTSIDE = [
  "madurai", "coimbatore", "trichy", "tiruchirappalli", "tiruchirapalli", "salem",
  "erode", "vellore", "villupuram", "viluppuram", "pondicherry", "puducherry",
  "tirunelveli", "thanjavur", "tanjore", "dindigul", "kanchipuram", "kanchi",
  "chengalpattu", "chengalpet", "tiruvannamalai", "cuddalore", "namakkal", "karur",
  "tirupur", "nagercoil", "hosur", "krishnagiri", "dharmapuri", "ariyalur",
  "perambalur", "pudukkottai", "sivaganga", "ramanathapuram", "virudhunagar",
  "theni", "nilgiris", "ooty", "udhagamandalam", "kanyakumari", "thoothukudi",
  "tuticorin", "nagapattinam", "tiruvarur", "mayiladuthurai", "kallakurichi",
  "tenkasi", "ranipet", "tirupathur", "tirupattur",
  "bangalore", "bengaluru", "hyderabad", "mumbai", "delhi", "kerala", "andhra",
  "karnataka", "telangana", "trivandrum", "kochi", "cochin", "mysore", "mysuru",
  "tirupati", "tirupathi", "nellore", "vijayawada", "kalpakkam", "mahabalipuram",
  "mamallapuram", "kovalam", "tindivanam", "gummidipoondi", "arakkonam",
  "sriperumbudur", "mahindra city", "marakkanam", "cheyyar",
];

const CHENNAI_AREAS = [
  "chennai", "madras", "cmbt", "koyambedu", "broadway", "parrys", "parry",
  "central", "egmore", "tambaram", "velachery", "adyar", "guindy", "t nagar",
  "t. nagar", "tnagar", "anna nagar", "mylapore", "vadapalani", "porur",
  "ambattur", "avadi", "perambur", "washermanpet", "triplicane", "saidapet",
  "chromepet", "chrompet", "pallavaram", "perungudi", "thoraipakkam", "taramani",
  "sholinganallur", "navalur", "siruseri", "kelambakkam", "medavakkam",
  "madipakkam", "nanganallur", "ashok nagar", "kodambakkam", "nungambakkam",
  "kilpauk", "purasaiwalkam", "purasawalkam", "royapettah", "mandaveli",
  "besant nagar", "thiruvanmiyur", "kottivakkam", "palavakkam", "neelankarai",
  "injambakkam", "kotturpuram", "teynampet", "alwarpet", "nandanam", "ekkaduthangal",
  "ekkattuthangal", "st thomas mount", "st. thomas mount", "meenambakkam",
  "pallikaranai", "omr", "ecr", "red hills", "madhavaram", "manali", "ennore",
  "tiruvottiyur", "thiruvottiyur", "kathivakkam", "minjur", "poonamallee",
  "maduravoyal", "valasaravakkam", "virugambakkam", "saligramam", "choolaimedu",
  "aminjikarai", "villivakkam", "korattur", "padi", "mogappair", "thirumangalam",
  "ashok pillar", "kasimedu", "high court", "marina", "ice house", "chepauk",
  "wallajah", "royapuram", "tondiarpet", "vyasarpadi", "sembiam", "icf",
  "little mount", "alandur", "pazhavanthangal", "palavanthangal", "tirusulam",
  "pammal", "anakaputhur", "kundrathur", "ramapuram", "mugalivakkam", "manapakkam",
  "nandambakkam", "kathipara", "vandalur", "urapakkam", "guduvanchery", "guduvancheri",
  "potheri", "maraimalai nagar", "singaperumal koil", "perungalathur", "peerkankaranai",
  "mannivakkam", "otteri", "mount road", "anna salai", "spencer", "chetpet",
  "shenoy nagar", "arumbakkam", "nerkundram", "thiruverkadu",
  "karapakkam", "thalambur", "semmancheri", "perumbakkam", "nolambur",
  "kolathur", "moolakadai", "retteri", "puzhal", "sholavaram",
  "thiruninravur", "pattabiram", "hvf", "thirumullaivoyal", "annanur",
  "kattupakkam", "iyyapanthangal", "mangadu", "gerugambakkam", "kovur",
];

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[.\-_/]/g, " ").replace(/\s+/g, " ").trim();
}

// Accept any place by default; reject only names that clearly belong to another
// city / district / state. CHENNAI_AREAS is kept only as documentation.
function isChennaiPlace(name) {
  const s = normalize(name);
  if (!s) return false;
  return !OUTSIDE.some((c) => s.includes(c));
}
void CHENNAI_AREAS;

// True only if the whole route (from, to, all stops) is within Chennai.
function isChennaiRoute(route) {
  const r = route || {};
  if (!isChennaiPlace(r.from) || !isChennaiPlace(r.to)) return false;
  const stops = Array.isArray(r.stops) ? r.stops : [];
  for (const s of stops) {
    const nm = typeof s === "string" ? s : (s && s.name);
    if (nm && !isChennaiPlace(nm)) return false;
  }
  return true;
}

module.exports = { isChennaiPlace, isChennaiRoute };
