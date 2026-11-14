package app.harborguard.youtube;

import java.net.IDN;
import java.net.URI;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Conservative third-party filtering for this YouTube-only client. */
public final class HostRules {
    public final Set<String> ads, trackers;
    public final Set<String> excludedRequests, excludedInitiators;
    public final List<Allowance> allowances;

    public HostRules(Set<String> ads, Set<String> trackers, Set<String> requests,
                     Set<String> initiators, List<Allowance> allowances) {
        this.ads = Collections.unmodifiableSet(new HashSet<>(ads));
        this.trackers = Collections.unmodifiableSet(new HashSet<>(trackers));
        this.excludedRequests = Collections.unmodifiableSet(new HashSet<>(requests));
        this.excludedInitiators = Collections.unmodifiableSet(new HashSet<>(initiators));
        this.allowances = Collections.unmodifiableList(allowances);
    }

    public static String hostOf(String url) {
        try {
            String host = URI.create(url).getHost();
            if (host == null) return "";
            host = host.toLowerCase(Locale.ROOT);
            while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
            return IDN.toASCII(host);
        } catch (RuntimeException error) { return ""; }
    }

    public static boolean matchesDomain(String host, Set<String> domains) {
        if (host.isEmpty()) return false;
        String candidate = host;
        while (true) {
            if (domains.contains(candidate)) return true;
            int dot = candidate.indexOf('.');
            if (dot < 0) return false;
            candidate = candidate.substring(dot + 1);
        }
    }

    public static boolean isYouTubeHost(String host) {
        return host.equals("youtube.com") || host.endsWith(".youtube.com");
    }

    public boolean shouldBlock(String url, String topHost, boolean mainFrame, boolean enabled,
                               boolean adsEnabled, boolean trackersEnabled) {
        if (!enabled || mainFrame || !isYouTubeHost(topHost)) return false;
        String host = hostOf(url);
        // The client only navigates to YouTube, so its first-party boundary is
        // unambiguous; no public-suffix approximation is used for other sites.
        if (host.isEmpty() || isYouTubeHost(host) || matchesDomain(host, excludedRequests)
            || matchesDomain(topHost, excludedInitiators)) return false;
        if (!(adsEnabled && matchesDomain(host, ads) || trackersEnabled && matchesDomain(host, trackers))) return false;
        for (Allowance rule : allowances) if (rule.matches(url, host, topHost)) return false;
        return true;
    }

    public static final class Allowance {
        public final Set<String> requests, excludedRequests, initiators, excludedInitiators;
        public final Pattern url;
        public final String domainType;

        public Allowance(String filter, boolean caseSensitive, String domainType, Set<String> requests,
                         Set<String> excludedRequests, Set<String> initiators, Set<String> excludedInitiators) {
            this.requests = requests; this.excludedRequests = excludedRequests;
            this.initiators = initiators; this.excludedInitiators = excludedInitiators;
            this.domainType = domainType;
            this.url = filter == null ? null : compileFilter(filter, caseSensitive);
        }

        public boolean matches(String value, String requestHost, String topHost) {
            if ("firstParty".equals(domainType)) return false;
            return (requests.isEmpty() || matchesDomain(requestHost, requests))
                && !matchesDomain(requestHost, excludedRequests)
                && (initiators.isEmpty() || matchesDomain(topHost, initiators))
                && !matchesDomain(topHost, excludedInitiators)
                && (url == null || url.matcher(value).find());
        }

        static Pattern compileFilter(String filter, boolean sensitive) {
            StringBuilder regex = new StringBuilder();
            int start = 0, end = filter.length();
            if (filter.startsWith("||")) { regex.append("^[A-Za-z]+://(?:[^/?#]*\\.)?"); start = 2; }
            else if (filter.startsWith("|")) { regex.append('^'); start = 1; }
            boolean anchored = end > start && filter.charAt(end - 1) == '|';
            if (anchored) end--;
            for (int index = start; index < end; index++) {
                char character = filter.charAt(index);
                if (character == '*') regex.append(".*");
                else if (character == '^') regex.append("(?:[^A-Za-z0-9_.%\\-]|$)");
                else regex.append(Pattern.quote(String.valueOf(character)));
            }
            if (anchored) regex.append('$');
            return Pattern.compile(regex.toString(), sensitive ? 0 : Pattern.CASE_INSENSITIVE);
        }
    }
}
