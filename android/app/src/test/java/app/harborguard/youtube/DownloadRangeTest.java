package app.harborguard.youtube;

import org.junit.Test;
import java.io.IOException;
import static org.junit.Assert.*;

public class DownloadRangeTest {
    @Test public void acceptsConsecutivePartialResponsesInsteadOfRejectingThem() throws Exception {
        DownloadRange first = DownloadRange.response(206, "bytes 0-1048575/2400000", 1048576, 0, -1);
        DownloadRange second = DownloadRange.response(206, "bytes 1048576-2097151/2400000", 1048576, first.length, first.total);
        DownloadRange last = DownloadRange.response(206, "bytes 2097152-2399999/2400000", 302848, first.length + second.length, second.total);
        assertEquals(2400000, first.length + second.length + last.length);
    }
    @Test public void acceptsGooglevideoHttp200RangeSlicesWithSignedLength() throws Exception {
        DownloadRange slice = DownloadRange.response(200, null, 1048576, 0, 2000000);
        DownloadRange last = DownloadRange.response(200, null, 951424, slice.length, slice.total);
        assertEquals(2000000, slice.length + last.length);
    }
    @Test public void acceptsWholeFileWhenServerIgnoresFirstRange() throws Exception {
        assertEquals(5000000, DownloadRange.response(200, null, 5000000, 0, 5000000).length);
    }
    @Test public void rejectsGapsRepeatedBytesAndChangedLength() {
        rejects(206, "bytes 0-1048575/2000000", 1048576, 1048576, 2000000);
        rejects(206, "bytes 1048577-1999999/2000000", 951423, 1048576, 2000000);
        rejects(206, "bytes 1048576-1999999/2000000", 951424, 1048576, 3000000);
        rejects(200, null, 2000000, 1048576, 2000000);
        rejects(206, null, 1048576, 0, 2000000);
    }
    @Test public void rejectsMalformedAndOverflowedRanges() {
        rejects(206, "bytes 0-18446744073709551615/18446744073709551616", -1, 0, -1);
        rejects(206, "bytes 10-9/20", 0, 10, 20);
        rejects(206, "bytes 0-99/*", 100, 0, -1);
    }
    private void rejects(int code, String range, long length, long offset, long total) {
        try { DownloadRange.response(code, range, length, offset, total); fail("Unsafe range accepted"); }
        catch (IOException expected) { }
    }
}
