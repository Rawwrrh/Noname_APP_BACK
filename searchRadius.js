// Port de la fórmula de radio de búsqueda del front (src/lib/searchRadius.ts).
// Se usa para el geofencing: a quién avisar cuando se publica una mascota perdida.

function norm(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function baseEspecie(especie, size) {
  const e = norm(especie);
  if (e === "felina" || e === "gato") return 0.3;
  if (e === "canina" || e === "perro") {
    const s = norm(size);
    if (s.includes("peque")) return 0.5;
    if (s.includes("median")) return 1.2;
    if (s.includes("grande")) return 2.5;
    return 1.2;
  }
  return 0.3; // ave / roedor / otros
}

function factorTemperamento(t) {
  const v = norm(t);
  if (v === "sociable") return 0.7;
  if (v === "timido" || v === "miedoso") return 1.8;
  return 1.0;
}

function factorTerreno(t) {
  const v = norm(t);
  if (v === "urbano") return 0.7;
  if (v === "rural") return 1.6;
  return 1.0;
}

function factorClima(c) {
  return norm(c) === "extremo" ? 0.6 : 1.0;
}

function daysSince(dob) {
  if (!dob) return 0;
  const t = new Date(dob).getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

// R_max en km (igual que computeRadius del front).
function rMaxKm(input) {
  const rEsp = baseEspecie(input.especie, input.size);
  const fTemp = factorTemperamento(input.temperamento);
  const fEster = norm(input.sexo) === "macho" && input.esterilizado === false ? 1.3 : 1.0;
  const fTerreno = factorTerreno(input.terreno);
  const fClima = factorClima(input.clima);
  const d = daysSince(input.dob);
  return rEsp * fTemp * fEster * fTerreno * fClima * Math.sqrt(d + 1);
}

// Distancia en km entre dos coordenadas (Haversine).
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

module.exports = { rMaxKm, distanceKm };
