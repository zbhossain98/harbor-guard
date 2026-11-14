package app.harborguard.youtube;

import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.*;
import android.content.res.ColorStateList;
import android.view.Gravity;
import android.view.View;
import android.widget.*;

/** Small native components: no remote fonts, UI framework or animated WebView. */
public final class Ui {
    public static final int BG = Color.rgb(15, 15, 15), SURFACE = Color.rgb(24, 24, 24), SOFT = Color.rgb(44, 44, 44);
    public static final int MINT = Color.rgb(161, 206, 255), TEXT = Color.rgb(241, 241, 241), MUTED = Color.rgb(170, 170, 170);
    public static int dp(Context c, float value) { return Math.round(value * c.getResources().getDisplayMetrics().density); }
    public static GradientDrawable round(Context c, int color, int radius) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(c, radius)); return shape;
    }
    public static void clickable(View view, int color, int radius, Runnable action) {
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), round(view.getContext(), color, radius), round(view.getContext(), Color.WHITE, radius)));
        view.setOnClickListener(v -> action.run());
    }
    public static TextView text(Context c, String value, int size, int color, boolean bold) {
        TextView text = new TextView(c); text.setText(value); text.setTextSize(size); text.setTextColor(color);
        text.setTypeface(Typeface.create(bold ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL)); return text;
    }
    public static LinearLayout column(Context c) { LinearLayout v = new LinearLayout(c); v.setOrientation(LinearLayout.VERTICAL); return v; }
    public static LinearLayout row(Context c) { LinearLayout v = new LinearLayout(c); v.setGravity(Gravity.CENTER_VERTICAL); return v; }
    public static ImageButton action(Context c, String type, String description, Runnable action) {
        ImageButton button = new ImageButton(c); button.setImageDrawable(icon(type, TEXT)); button.setContentDescription(description);
        button.setPadding(dp(c, 12), dp(c, 12), dp(c, 12), dp(c, 12));
        clickable(button, Color.TRANSPARENT, 16, action); return button;
    }
    public static TextView pill(Context c, String label, boolean primary, Runnable action) {
        TextView text = text(c, label, 14, primary ? BG : TEXT, true); text.setGravity(Gravity.CENTER);
        text.setPadding(dp(c, 16), dp(c, 14), dp(c, 16), dp(c, 14)); clickable(text, primary ? MINT : SOFT, 16, action); return text;
    }
    public static String time(double seconds) {
        int value = (int)Math.max(0, seconds); return value >= 3600 ? String.format(java.util.Locale.ROOT, "%d:%02d:%02d", value / 3600, value / 60 % 60, value % 60) : String.format(java.util.Locale.ROOT, "%d:%02d", value / 60, value % 60);
    }
    public static Drawable icon(String kind, int color) {
        return new Drawable() {
            private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            @Override public void draw(Canvas canvas) {
                canvas.save(); canvas.translate(getBounds().left, getBounds().top);
                canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
                paint.setColor(color); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(1.8f); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
                Path p = new Path();
                switch (kind) {
                    case "more": paint.setStyle(Paint.Style.FILL); canvas.drawCircle(4, 12, 1.8f, paint); canvas.drawCircle(12, 12, 1.8f, paint); canvas.drawCircle(20, 12, 1.8f, paint); break;
                    case "library": canvas.drawRoundRect(4, 6, 20, 21, 2, 2, paint); p.moveTo(7, 3); p.lineTo(17, 3); p.moveTo(10, 10); p.lineTo(16, 13.5f); p.lineTo(10, 17); p.close(); break;
                    case "home": p.moveTo(3, 10); p.lineTo(12, 3); p.lineTo(21, 10); p.moveTo(5, 9); p.lineTo(5, 21); p.lineTo(10, 21); p.lineTo(10, 15); p.lineTo(14, 15); p.lineTo(14, 21); p.lineTo(19, 21); p.lineTo(19, 9); break;
                    case "shorts": p.moveTo(16, 3); p.cubicTo(21, 3, 23, 8, 18, 11); p.lineTo(20, 12); p.cubicTo(25, 16, 20, 20, 16, 21); p.lineTo(8, 21); p.cubicTo(3, 21, 1, 16, 6, 13); p.lineTo(4, 12); p.cubicTo(-1, 8, 5, 4, 8, 3); p.close(); canvas.drawPath(p, paint); p.reset(); p.moveTo(10, 9); p.lineTo(15, 12); p.lineTo(10, 15); p.close(); break;
                    case "download": p.moveTo(12, 3); p.lineTo(12, 16); p.moveTo(7, 11); p.lineTo(12, 16); p.lineTo(17, 11); p.moveTo(4, 17); p.lineTo(4, 21); p.lineTo(20, 21); p.lineTo(20, 17); break;
                    case "search": canvas.drawCircle(10, 10, 6.5f, paint); p.moveTo(15, 15); p.lineTo(21, 21); break;
                    case "music": canvas.drawArc(4, 3, 20, 21, 180, 180, false, paint); canvas.drawRoundRect(3, 12, 7, 21, 2, 2, paint); canvas.drawRoundRect(17, 12, 21, 21, 2, 2, paint); break;
                    case "settings": canvas.drawCircle(12, 12, 4, paint); canvas.drawCircle(12, 12, 8, paint); for (int n = 0; n < 8; n++) { double a = n * Math.PI / 4; canvas.drawLine(12 + (float)Math.cos(a) * 8, 12 + (float)Math.sin(a) * 8, 12 + (float)Math.cos(a) * 10, 12 + (float)Math.sin(a) * 10, paint); } break;
                    case "play": paint.setStyle(Paint.Style.FILL); p.moveTo(8, 4); p.lineTo(21, 12); p.lineTo(8, 20); p.close(); break;
                    case "pause": paint.setStyle(Paint.Style.FILL); canvas.drawRoundRect(6, 4, 10, 20, 1, 1, paint); canvas.drawRoundRect(14, 4, 18, 20, 1, 1, paint); break;
                    case "back": p.moveTo(15, 4); p.lineTo(7, 12); p.lineTo(15, 20); break;
                    case "shield": p.moveTo(12, 2); p.lineTo(21, 6); p.lineTo(21, 12); p.cubicTo(21, 18, 16, 21, 12, 23); p.cubicTo(8, 21, 3, 18, 3, 12); p.lineTo(3, 6); p.close(); canvas.drawPath(p, paint); p.reset(); p.moveTo(8, 12); p.lineTo(11, 15); p.lineTo(16, 9); break;
                    case "share": canvas.drawCircle(18, 4, 2.5f, paint); canvas.drawCircle(5, 12, 2.5f, paint); canvas.drawCircle(18, 20, 2.5f, paint); p.moveTo(7, 11); p.lineTo(16, 5); p.moveTo(7, 13); p.lineTo(16, 19); break;
                    default: p.moveTo(6, 6); p.lineTo(18, 18); p.moveTo(18, 6); p.lineTo(6, 18);
                }
                canvas.drawPath(p, paint); canvas.restore();
            }
            @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
            @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        };
    }
}
