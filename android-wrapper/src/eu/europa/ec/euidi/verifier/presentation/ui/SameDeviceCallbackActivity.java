package eu.europa.ec.euidi.verifier.presentation.ui;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

public class SameDeviceCallbackActivity extends Activity {
    private static final String TAG = "ZenBankCallback";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent incoming = getIntent();
        Uri data = incoming != null ? incoming.getData() : null;
        Log.i(
                TAG,
                "Callback received host="
                        + (data != null ? data.getHost() : "null")
                        + " hasFragment="
                        + (data != null && data.getEncodedFragment() != null)
                        + " hasQuery="
                        + (data != null && data.getEncodedQuery() != null));

        Intent forward = new Intent(this, ro.banking40.team04.MainActivity.class);
        forward.setAction(Intent.ACTION_VIEW);
        if (data != null) {
            forward.setData(data);
        }
        forward.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(forward);
        finish();
    }
}
