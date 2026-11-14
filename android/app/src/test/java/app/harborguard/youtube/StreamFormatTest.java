package app.harborguard.youtube;

import org.junit.Test;
import static org.junit.Assert.*;

public class StreamFormatTest {
    private String url(int tag) { return "https://rr1.googlevideo.com/videoplayback?source=youtube&id=content&itag=" + tag + "&clen=1234567"; }
    @Test public void detectsPlaybackWebmVideoAndOpusAudio() {
        StreamFormat video = StreamFormat.observed(url(244)), audio = StreamFormat.observed(url(251));
        assertEquals(480, video.height); assertTrue(video.mime.contains("vp9"));
        assertEquals(0, audio.height); assertTrue(audio.mime.contains("opus")); assertFalse(video.combined);
    }
    @Test public void distinguishesProgressiveMp4AndSeparateAudio() {
        assertTrue(StreamFormat.observed(url(18)).combined);
        assertFalse(StreamFormat.observed(url(140)).combined);
        assertTrue(StreamFormat.observed(url(140)).mime.startsWith("audio/"));
    }
    @Test public void ignoresUnknownFormatsAndNonYoutubeMedia() {
        assertNull(StreamFormat.observed(url(9999)));
        assertNull(StreamFormat.observed(url(244).replace("source=youtube", "source=ad")));
        assertNull(StreamFormat.observed(url(244).replace("rr1.googlevideo.com", "googlevideo.com.evil.example")));
        assertNull(StreamFormat.observed(url(244).replace("https:", "http:")));
    }
    @Test public void preservesEncodedSignatureAndRecognizesLengthHints() {
        String signed = url(244) + "&sig=a%2Bb%2Fc%3D&range=0-100";
        assertTrue(DownloadPolicy.completeUrl(signed).contains("sig=a%2Bb%2Fc%3D"));
        assertEquals(1234567, DownloadRange.lengthHint(signed));
        assertEquals("Sample.webm", DownloadPolicy.filename("Sample", false, true));
    }
}
