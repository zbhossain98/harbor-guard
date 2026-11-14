package app.harborguard.youtube;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

public class HostRulesTest {
    private static Set<String> set(String... items) { return new HashSet<>(Arrays.asList(items)); }
    private HostRules engine() { return new HostRules(set("ads.example"), set("tracker.example"), set(), set(), Collections.emptyList()); }

    @Test public void categoryTogglesAndMainFrames() {
        HostRules rules = engine();
        assertTrue(rules.shouldBlock("https://a.ads.example/a.js", "m.youtube.com", false, true, true, false));
        assertFalse(rules.shouldBlock("https://ads.example/a.js", "m.youtube.com", true, true, true, true));
        assertFalse(rules.shouldBlock("https://ads.example/a.js", "m.youtube.com", false, false, true, true));
        assertFalse(rules.shouldBlock("https://ads.example/a.js", "m.youtube.com", false, true, false, true));
        assertTrue(rules.shouldBlock("https://tracker.example/pixel", "m.youtube.com", false, true, false, true));
    }
    @Test public void boundariesAndPlaybackHosts() {
        HostRules rules = engine();
        assertFalse(rules.shouldBlock("https://ads.example.evil.test/a", "m.youtube.com", false, true, true, true));
        assertFalse(rules.shouldBlock("https://m.youtube.com/youtubei/v1/player", "m.youtube.com", false, true, true, true));
        assertFalse(rules.shouldBlock("https://r1.googlevideo.com/videoplayback", "m.youtube.com", false, true, true, true));
        assertFalse(rules.shouldBlock("https://ads.example/a", "elsewhere.example", false, true, true, true));
    }
    @Test public void scopedAllowancesPreserveCompatibleRequests() {
        HostRules.Allowance allowance = new HostRules.Allowance("||ads.example/needed*", false, "thirdParty", set(), set(), set("youtube.com"), set("music.youtube.com"));
        HostRules rules = new HostRules(set("ads.example"), set(), set(), set(), Collections.singletonList(allowance));
        assertFalse(rules.shouldBlock("https://ads.example/needed.js", "m.youtube.com", false, true, true, true));
        assertTrue(rules.shouldBlock("https://ads.example/banner.js", "m.youtube.com", false, true, true, true));
        assertTrue(rules.shouldBlock("https://ads.example/needed.js", "music.youtube.com", false, true, true, true));
        assertFalse(allowance.matches("https://ads.example.evil.test/needed.js", "ads.example.evil.test", "m.youtube.com"));
    }
    @Test public void exclusionsAndSeparatorPatterns() {
        HostRules rules = new HostRules(set("ads.example"), set(), set("ads.example"), set(), Collections.emptyList());
        assertFalse(rules.shouldBlock("https://sub.ads.example/a", "m.youtube.com", false, true, true, true));
        HostRules.Allowance allowance = new HostRules.Allowance("||ads.example^", false, "", set(), set(), set(), set());
        assertTrue(allowance.matches("https://ads.example/a", "ads.example", "m.youtube.com"));
        assertFalse(allowance.matches("https://ads.example2/a", "ads.example2", "m.youtube.com"));
        assertEquals("m.youtube.com", HostRules.hostOf("https://M.YouTube.com./watch?v=abc"));
    }
}
