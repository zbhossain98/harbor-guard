package app.harborguard.youtube;

import android.content.res.AssetManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class RuleStore {
    public static String text(AssetManager assets, String name) throws Exception {
        try (InputStream stream = assets.open(name); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int length;
            while ((length = stream.read(buffer)) != -1) output.write(buffer, 0, length);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static Set<String> set(JSONArray array) {
        Set<String> values = new HashSet<>();
        if (array != null) for (int i = 0; i < array.length(); i++) values.add(array.optString(i));
        return values;
    }

    public static HostRules load(AssetManager assets) throws Exception {
        JSONObject data = new JSONObject(text(assets, "filters.json"));
        List<HostRules.Allowance> allowances = new ArrayList<>();
        JSONArray rules = data.getJSONArray("allowances");
        for (int i = 0; i < rules.length(); i++) {
            JSONObject rule = rules.getJSONObject(i);
            allowances.add(new HostRules.Allowance(rule.has("urlFilter") ? rule.getString("urlFilter") : null,
                rule.optBoolean("isUrlFilterCaseSensitive"), rule.optString("domainType"),
                set(rule.optJSONArray("requestDomains")), set(rule.optJSONArray("excludedRequestDomains")),
                set(rule.optJSONArray("initiatorDomains")), set(rule.optJSONArray("excludedInitiatorDomains"))));
        }
        return new HostRules(set(data.getJSONArray("ads")), set(data.getJSONArray("trackers")),
            set(data.getJSONArray("excludedRequests")), set(data.getJSONArray("excludedInitiators")), allowances);
    }
}
