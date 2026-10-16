const fs = require("fs");
const path = require("path");

function readEnvValue() {
  if (process.env.ACCESS_CODES) return process.env.ACCESS_CODES;
  const files = [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const line = text.split(/\n/).find((row) => row.startsWith("ACCESS_CODES="));
      if (line) return line.slice("ACCESS_CODES=".length).trim().replace(/^["']|["']$/g, "");
    } catch (err) {
      // try next path
    }
  }
  return "";
}

function loadCodes() {
  return readEnvValue()
    .split(/[,\s]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

module.exports = (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, reason: "method" });
    return;
  }

  const codes = loadCodes();
  if (!codes.length) {
    res.status(503).json({ ok: false, reason: "missing_env" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = {};
    }
  }

  const code = String((body && body.code) || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const ok = codes.includes(code);
  res.status(ok ? 200 : 401).json({ ok });
};
