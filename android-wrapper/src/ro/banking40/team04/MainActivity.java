package ro.banking40.team04;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String TAG = "ZenBank";
    private static final String APP_URL =
            "https://zenbank-eudi-825682833200.europe-west1.run.app/?client=android";
    private static final String CALLBACK_SCHEME = "ro.banking40.team04";
    private static final String CALLBACK_HOST = "same-device";

    private WebView webView;
    private boolean pageLoaded = false;
    private String pendingCallbackJs = null;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(0xFF0B1118);
        window.setNavigationBarColor(0xFF0B1118);

        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(0xFF0B1118);

        if (Build.VERSION.SDK_INT >= 30) {
            container.setOnApplyWindowInsetsListener(
                    new View.OnApplyWindowInsetsListener() {
                        @Override
                        public WindowInsets onApplyWindowInsets(
                                View view, WindowInsets windowInsets) {
                            Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars());
                            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                            return WindowInsets.CONSUMED;
                        }
                    });
        }

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0B1118);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " ZenBankAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase() : "";
                String host = uri.getHost() != null ? uri.getHost().toLowerCase() : "";

                if (("https".equals(scheme) || "http".equals(scheme))
                        && (host.endsWith(".run.app")
                                || "localhost".equals(host)
                                || "10.0.2.2".equals(host))) {
                    return false;
                }

                try {
                    Log.i(TAG, "Launching external scheme=" + scheme);
                    Intent externalIntent = new Intent(Intent.ACTION_VIEW, uri);
                    externalIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(externalIntent);
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(
                                    MainActivity.this,
                                    "Aplicația EUDI Wallet nu este instalată pe dispozitiv.",
                                    Toast.LENGTH_LONG)
                            .show();
                }
                return true;
            }

            @Override
            public void onPageFinished(final WebView view, String url) {
                super.onPageFinished(view, url);
                pageLoaded = true;
                if (pendingCallbackJs != null) {
                    final String js = pendingCallbackJs;
                    pendingCallbackJs = null;
                    view.post(
                            new Runnable() {
                                @Override
                                public void run() {
                                    view.evaluateJavascript(js, null);
                                }
                            });
                }
            }
        });

        container.addView(
                webView,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(container);

        handleCallbackIntent(getIntent());
        webView.loadUrl(APP_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCallbackIntent(intent);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private void handleCallbackIntent(Intent intent) {
        if (intent == null) {
            return;
        }
        Uri data = intent.getData();
        if (data == null
                || !CALLBACK_SCHEME.equals(data.getScheme())
                || !CALLBACK_HOST.equals(data.getHost())) {
            return;
        }

        String responseCode = extractParam(data, "response_code");
        String error = extractParam(data, "error_description");
        if (error == null || error.isEmpty()) {
            error = extractParam(data, "error");
        }

        Log.i(
                TAG,
                "Delivering callback hasCode="
                        + (responseCode != null && !responseCode.isEmpty())
                        + " hasError="
                        + (error != null && !error.isEmpty())
                        + " pageLoaded="
                        + pageLoaded);

        String codeArg =
                (responseCode != null && !responseCode.isEmpty())
                        ? JSONObject.quote(responseCode)
                        : "null";
        String errArg =
                (error != null && !error.isEmpty()) ? JSONObject.quote(error) : "null";
        String js =
                "(function(){var c="
                        + codeArg
                        + ",e="
                        + errArg
                        + ";"
                        + "if(typeof window.__zenbankHandleEudiCallback==='function'){"
                        + "window.__zenbankHandleEudiCallback(c,e);"
                        + "}else{"
                        + "window.__zenbankPendingEudiCallback={responseCode:c,walletError:e};"
                        + "}})();";

        final String callbackJs = js;
        if (pageLoaded && webView != null) {
            webView.post(
                    new Runnable() {
                        @Override
                        public void run() {
                            webView.evaluateJavascript(callbackJs, null);
                        }
                    });
        } else {
            pendingCallbackJs = callbackJs;
        }
    }

    private static String extractParam(Uri uri, String key) {
        String val = uri.getQueryParameter(key);
        if (val != null && !val.trim().isEmpty()) {
            return val.trim();
        }
        String fragment = uri.getEncodedFragment();
        if (fragment != null && !fragment.isEmpty()) {
            if (fragment.startsWith("?")) {
                fragment = fragment.substring(1);
            }
            Uri fragUri = Uri.parse("https://dummy.local/?" + fragment);
            String fragVal = fragUri.getQueryParameter(key);
            if (fragVal != null && !fragVal.trim().isEmpty()) {
                return fragVal.trim();
            }
        }
        return null;
    }
}
