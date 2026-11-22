package nl.wouter.poule;

import android.content.Context;
import android.webkit.WebResourceResponse;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Updates zonder nieuwe APK, zoals in W2 Apps.
 * De pagina's komen van de branch 'uitgifte' in Woetoe/poule-app: manifest.json noemt per bestand de sha256,
 * de bestanden staan als f/&lt;sha256&gt;. manifest.sig is een ECDSA-handtekening (P-256) over manifest.json;
 * de app controleert die met de publieke sleutel uit android/update_key.pem en weigert alles wat niet klopt.
 * Gedownloade bestanden komen in files/www-live en gaan voor op de ingebouwde assets.
 * Alleen als de Android-schil verandert (native_version omhoog) is een nieuwe APK nodig.
 */
class Updater {
    interface Listener {
        void onUpdate(String state, JSONObject info);
    }

    private final Context ctx;
    private final Listener listener;
    private final File live, staging, old;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean busy;

    Updater(Context ctx, Listener listener) {
        this.ctx = ctx;
        this.listener = listener;
        live = new File(ctx.getFilesDir(), "www-live");
        staging = new File(ctx.getFilesDir(), "www-staging");
        old = new File(ctx.getFilesDir(), "www-old");
    }

    // ------------------------------------------------------------ opstarten en serveren

    /** Gooit een download weg die niet nieuwer is dan wat in de APK zit, of voor een andere schil. */
    void cleanup() {
        deleteRec(staging);
        deleteRec(old);
        JSONObject lm = readJson(new File(live, "manifest.json"));
        if (lm == null || lm.optInt("build") <= assetBuild() || lm.optInt("native") != BuildConfig.NATIVE_VERSION) {
            deleteRec(live);
        }
    }

    private int assetBuild() {
        JSONObject am = assetManifest();
        return am != null ? am.optInt("build") : 0;
    }

    int currentBuild() {
        JSONObject lm = readJson(new File(live, "manifest.json"));
        return Math.max(lm != null ? lm.optInt("build") : 0, assetBuild());
    }

    String versionName() {
        return BuildConfig.VERSION_PREFIX + currentBuild();
    }

    /** Antwoord voor een pad als /www/index.html: eerst de gedownloade versie, anders de ingebouwde. */
    WebResourceResponse serve(String path) {
        if (path == null || !path.startsWith("/www/")) return notFound();
        String rel = path.substring(5);
        if (rel.isEmpty()) rel = "index.html";
        if (rel.contains("..")) return notFound();
        try {
            InputStream in;
            File f = new File(live, rel);
            if (f.isFile() && f.getCanonicalPath().startsWith(live.getCanonicalPath() + File.separator)) {
                in = new FileInputStream(f);
            } else {
                in = ctx.getAssets().open("www/" + rel);
            }
            String mime = mime(rel);
            boolean text = mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json");
            WebResourceResponse r = new WebResourceResponse(mime, text ? "utf-8" : null, in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    static String mime(String p) {
        String l = p.toLowerCase();
        if (l.endsWith(".html")) return "text/html";
        if (l.endsWith(".js")) return "application/javascript";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".json")) return "application/json";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------ zoeken en bijwerken

    /** Zoekt een update en zet hem meteen klaar. Stil = geen meldingen bij 'zoeken' of fouten. */
    void check(final boolean silent) {
        if (busy) return;
        busy = true;
        worker.execute(() -> {
            try {
                if (!silent) emit("checking", null);
                JSONObject r = fetchManifest();
                int build = r.optInt("build");
                String version = BuildConfig.VERSION_PREFIX + build;
                if (r.optInt("native") > BuildConfig.NATIVE_VERSION) {
                    JSONObject i = new JSONObject();
                    i.put("version", version);
                    i.put("url", r.optString("apkUrl"));
                    emit("apk", i);
                    return;
                }
                if (build <= currentBuild()) {
                    if (!silent) emit("none", info("version", versionName()));
                    return;
                }
                apply(r);
                emit("ready", info("version", version));
            } catch (Exception e) {
                deleteRec(staging);
                if (!silent) emit("error", info("message", String.valueOf(e.getMessage())));
            } finally {
                busy = false;
            }
        });
    }

    private void apply(JSONObject r) throws Exception {
        JSONObject files = r.getJSONObject("files");
        JSONObject am = assetManifest();
        JSONObject af = am != null ? am.optJSONObject("files") : null;
        JSONObject lm = readJson(new File(live, "manifest.json"));
        JSONObject lf = lm != null ? lm.optJSONObject("files") : null;

        deleteRec(staging);
        if (!staging.mkdirs()) throw new IOException("kan map niet maken");
        for (Iterator<String> it = files.keys(); it.hasNext(); ) {
            String path = it.next();
            String h = files.getJSONObject(path).optString("h");
            File dest = new File(staging, path);
            if (!dest.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)) continue;
            if (af != null && af.has(path) && h.equals(af.getJSONObject(path).optString("h"))) {
                continue; // zit al zo in de app
            }
            if (lf != null && lf.has(path) && h.equals(lf.getJSONObject(path).optString("h")) && new File(live, path).isFile()) {
                write(dest, readAll(new FileInputStream(new File(live, path))));
                continue;
            }
            byte[] data = download(BuildConfig.UPDATE_BASE + "f/" + h);
            if (!h.equals(sha256(data))) throw new IOException("bestand klopt niet met het manifest: " + path);
            write(dest, data);
        }
        write(new File(staging, "manifest.json"), r.toString().getBytes(StandardCharsets.UTF_8));
        deleteRec(old);
        if (live.exists() && !live.renameTo(old)) throw new IOException("kan oude versie niet opzij zetten");
        if (!staging.renameTo(live)) throw new IOException("kan nieuwe versie niet plaatsen");
        deleteRec(old);
    }

    /** manifest.json + manifest.sig ophalen en de handtekening controleren. */
    private JSONObject fetchManifest() throws Exception {
        long t = System.currentTimeMillis();
        byte[] body = download(BuildConfig.UPDATE_BASE + "manifest.json?t=" + t);
        byte[] sig = download(BuildConfig.UPDATE_BASE + "manifest.sig?t=" + t);
        if (!verify(body, sig)) throw new IOException("handtekening van de update klopt niet");
        return new JSONObject(new String(body, StandardCharsets.UTF_8));
    }

    static boolean verify(byte[] body, byte[] sigBase64) {
        try {
            byte[] der = android.util.Base64.decode(new String(sigBase64, StandardCharsets.US_ASCII).trim(), android.util.Base64.DEFAULT);
            PublicKey pk = KeyFactory.getInstance("EC").generatePublic(
                    new X509EncodedKeySpec(android.util.Base64.decode(BuildConfig.UPDATE_PUBKEY, android.util.Base64.DEFAULT)));
            Signature v = Signature.getInstance("SHA256withECDSA");
            v.initVerify(pk);
            v.update(body);
            return v.verify(der);
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------ hulp

    private void emit(String state, JSONObject info) {
        listener.onUpdate(state, info != null ? info : new JSONObject());
    }

    private static JSONObject info(String k, String v) {
        JSONObject o = new JSONObject();
        try {
            o.put(k, v);
        } catch (Exception ignored) {
        }
        return o;
    }

    private JSONObject assetManifest() {
        try (InputStream in = ctx.getAssets().open("www/manifest.json")) {
            return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONObject readJson(File f) {
        if (!f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static byte[] download(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "PouleApp");
        c.setRequestProperty("Cache-Control", "no-cache");
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("server gaf " + code);
            try (InputStream in = c.getInputStream()) {
                return readAll(in);
            }
        } finally {
            c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream src = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[32768];
            int n;
            while ((n = src.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void write(File f, byte[] data) throws IOException {
        File dir = f.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs()) throw new IOException("kan map niet maken");
        try (OutputStream os = new FileOutputStream(f)) {
            os.write(data);
        }
    }

    static String sha256(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    static void deleteRec(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRec(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
