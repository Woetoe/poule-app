package nl.wouter.poule;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * Toont de poule-pagina's in een WebView. De pagina's komen van https://appassets.androidplatform.net/www/…,
 * een adres dat nooit het internet op gaat: de app levert ze zelf, eerst uit de laatste update, anders uit de APK.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/www/index.html";
    private static final int PICK_FILE = 42;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Updater updater;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private String lastApkUrl = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(0xFF111111);
        w.setNavigationBarColor(0xFF111111);

        updater = new Updater(this, this::onUpdate);
        updater.cleanup();

        web = new WebView(this);
        web.setBackgroundColor(0xFF111111);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        web.addJavascriptInterface(new Bridge(), "PouleApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                return updater.serve(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openExternal(u);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Kies Excel-bestand"), PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(START);
        setContentView(web);

        // Bij elke start stil zoeken naar een update; die staat klaar zodra je een pagina opent.
        updater.check(true);
    }

    /** Komt van de Updater (achtergrondthread). */
    private void onUpdate(String state, JSONObject info) {
        ui.post(() -> {
            if ("ready".equals(state)) {
                Toast.makeText(this, "Poule bijgewerkt naar " + info.optString("version"), Toast.LENGTH_SHORT).show();
                String url = web.getUrl();
                if (url == null || url.endsWith("/index.html")) web.reload();
            }
            if ("apk".equals(state)) lastApkUrl = info.optString("url");
            try {
                info.put("state", state);
            } catch (Exception ignored) {
            }
            web.evaluateJavascript("window.pouleUpdate&&window.pouleUpdate(" + info + ")", null);
        });
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) {
        }
    }

    /** Voor het startscherm: versie tonen, zoeken naar updates, nieuwe APK ophalen. */
    class Bridge {
        @JavascriptInterface
        public String version() {
            return updater.versionName();
        }

        @JavascriptInterface
        public void check() {
            updater.check(false);
        }

        @JavascriptInterface
        public void downloadApk() {
            String url = lastApkUrl.isEmpty() ? "https://github.com/Woetoe/poule-app/releases/latest" : lastApkUrl;
            ui.post(() -> openExternal(Uri.parse(url)));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
