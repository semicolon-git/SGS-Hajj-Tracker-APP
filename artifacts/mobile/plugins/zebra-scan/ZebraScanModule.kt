package com.semicolon.sgsbagscan.zebra

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Bridges Zebra DataWedge -> React Native.
 *
 * Listens for the broadcast intent that DataWedge fires on every successful
 * trigger pull and forwards the decoded barcode payload to JS as a
 * "ZebraScan" DeviceEventEmitter event. The JS layer (hooks/useScanner.ts)
 * is already wired to consume that event.
 *
 * Also auto-configures the DataWedge profile on first launch so that ops do
 * not have to set it up manually for every new device. The manual recovery
 * steps are documented in docs/zebra-datawedge-setup.md.
 */
class ZebraScanModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "ZebraScanModule"
    private const val SCAN_ACTION = "com.semicolon.sgsbagscan.SCAN"
    private const val DATAWEDGE_PKG = "com.symbol.datawedge"

    // DataWedge API actions / extras (string literals so we don't depend on
    // a Zebra SDK jar — these are stable across DataWedge versions).
    private const val DW_ACTION = "com.symbol.datawedge.api.ACTION"
    private const val DW_RESULT_ACTION = "com.symbol.datawedge.api.RESULT_ACTION"
    private const val DW_EXTRA_CREATE_PROFILE = "com.symbol.datawedge.api.CREATE_PROFILE"
    private const val DW_EXTRA_SET_CONFIG = "com.symbol.datawedge.api.SET_CONFIG"
    private const val DW_EXTRA_SEND_RESULT = "SEND_RESULT"
    private const val DW_EXTRA_COMMAND_IDENTIFIER = "COMMAND_IDENTIFIER"
    private const val PROFILE_NAME = "SGSBagScan"

    // Delay between CREATE_PROFILE and SET_CONFIG. CREATE_PROFILE is async
    // inside DataWedge — sending SET_CONFIG immediately can lose the
    // config to a not-yet-existent profile. 250ms is empirically reliable
    // and still imperceptible at app launch.
    private const val CONFIG_CHAIN_DELAY_MS = 250L
  }

  private var receiver: BroadcastReceiver? = null
  private var resultReceiver: BroadcastReceiver? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun getName(): String = "ZebraScanModule"

  override fun initialize() {
    super.initialize()
    registerReceiver()
    registerResultReceiver()
    // Fire-and-forget — DataWedge ignores duplicate creates.
    try {
      configureDataWedgeProfile(commandId = "auto-init")
    } catch (t: Throwable) {
      Log.w(TAG, "DataWedge auto-config failed (likely non-Zebra device)", t)
    }
  }

  override fun invalidate() {
    unregisterReceiver()
    unregisterResultReceiver()
    super.invalidate()
  }

  // ---------- Scan broadcast receiver ----------

  private fun registerReceiver() {
    if (receiver != null) return
    val ctx: Context = reactApplicationContext.applicationContext
    val filter = IntentFilter(SCAN_ACTION).apply {
      addCategory(Intent.CATEGORY_DEFAULT)
    }
    receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SCAN_ACTION) return
        val data = intent.getStringExtra("com.symbol.datawedge.data_string")
          ?: intent.getStringExtra("data_string")
          ?: return
        val symbology = intent.getStringExtra("com.symbol.datawedge.label_type")
          ?: intent.getStringExtra("label_type")
        Log.d(TAG, "Scan received: type=$symbology len=${data.length}")
        emitScan(data, symbology)
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      ctx.registerReceiver(receiver, filter)
    }
  }

  private fun unregisterReceiver() {
    val r = receiver ?: return
    try {
      reactApplicationContext.applicationContext.unregisterReceiver(r)
    } catch (_: IllegalArgumentException) {
      // Already unregistered.
    }
    receiver = null
  }

  // ---------- DataWedge result receiver ----------
  //
  // DataWedge sends each API call's outcome back via DW_RESULT_ACTION. We
  // log every result so that on a misbehaving device the only debugging
  // step is `adb logcat ZebraScanModule:V *:S`. Without this, every
  // sendBroadcast was fire-and-forget and a typo'd profile or rejected
  // config would silently no-op.

  private fun registerResultReceiver() {
    if (resultReceiver != null) return
    val ctx = reactApplicationContext.applicationContext
    val filter = IntentFilter(DW_RESULT_ACTION).apply {
      addCategory(Intent.CATEGORY_DEFAULT)
    }
    resultReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val cmdId = intent.getStringExtra(DW_EXTRA_COMMAND_IDENTIFIER) ?: "?"
        val result = intent.getStringExtra("RESULT") ?: "?"
        val resultInfo = intent.getBundleExtra("RESULT_INFO")
        Log.d(TAG, "DataWedge result: cmd=$cmdId result=$result info=$resultInfo")
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ctx.registerReceiver(resultReceiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      ctx.registerReceiver(resultReceiver, filter)
    }
  }

  private fun unregisterResultReceiver() {
    val r = resultReceiver ?: return
    try {
      reactApplicationContext.applicationContext.unregisterReceiver(r)
    } catch (_: IllegalArgumentException) {
      // Already unregistered.
    }
    resultReceiver = null
  }

  // ---------- Scan emission to JS ----------

  private fun emitScan(data: String, symbology: String?) {
    if (!reactApplicationContext.hasActiveReactInstance()) {
      Log.w(TAG, "Dropping scan — no active React instance")
      return
    }
    val payload = Arguments.createMap().apply {
      putString("data", data)
      if (symbology != null) putString("symbology", symbology)
    }
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("ZebraScan", payload)
    val toastText = if (symbology?.uppercase()?.contains("PDF417") == true)
      buildBtpToastText(data)
    else
      "Scanned [${symbology ?: "unknown"}]\n$data"
    Toast.makeText(
      reactApplicationContext.applicationContext,
      toastText,
      Toast.LENGTH_SHORT,
    ).show()
  }

  /**
   * Builds a multi-line toast string from a raw BTP PDF417 payload,
   * showing each decoded field on its own line so the agent can confirm
   * every field was read correctly before the scan is queued.
   */
  private fun buildBtpToastText(raw: String): String {
    val lines = mutableListOf("PDF417 decoded:")
    // Tag number (SGS: BG191399, SGS-JED-..., NOTAG-...)
    val tagMatch = Regex("""(?i)\b((?:BG|SGS|NOTAG)[A-Z0-9\-]{3,25})\b""").find(raw)
      ?: Regex("""\b([0-9]{10,13})\b""").find(raw)
    tagMatch?.value?.let { lines.add("Tag:     $it") }
    // Passenger name (SURNAME/GIVEN)
    Regex("""(?i)\b([A-Z]{2,}/[A-Z]{2,})\b""").find(raw)?.value
      ?.let { lines.add("Pilgrim: $it") }
    // Carrier + flight number (e.g. EC135)
    val flightResult = Regex("""\b([A-Z]{2})\s*([0-9]{1,4})\b""").find(raw)
    flightResult?.let { lines.add("Flight:  ${it.groupValues[1]}${it.groupValues[2]}") }
    val carrierCode = flightResult?.groupValues?.get(1)
    // IATA 3-letter station code
    Regex("""\b([A-Z]{3})\b""").findAll(raw)
      .map { it.value }
      .firstOrNull { it != carrierCode }
      ?.let { lines.add("Station: $it") }
    // PNR (6-char alphanumeric, uppercase)
    val tagPrefix = tagMatch?.value?.take(6) ?: ""
    Regex("""\b([A-Z][A-Z0-9]{5})\b""").findAll(raw)
      .map { it.value }
      .firstOrNull { it != tagPrefix && it != carrierCode }
      ?.let { lines.add("PNR:     $it") }
    // Sequential bag number
    Regex("""(?i)\bBN[:\s]*([0-9]{1,4})\b""").find(raw)
      ?.groupValues?.get(1)
      ?.let { lines.add("BN:      $it") }
    return lines.joinToString("\n")
  }

  // ---------- DataWedge profile setup ----------

  private fun isDataWedgeInstalled(): Boolean {
    val pm = reactApplicationContext.applicationContext.packageManager
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getPackageInfo(DATAWEDGE_PKG, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(DATAWEDGE_PKG, 0)
      }
      true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }
  }

  /**
   * Programmatically creates the DataWedge profile bound to this app and
   * configures it to broadcast scans to SCAN_ACTION. Idempotent — DataWedge
   * silently ignores duplicate profile creates.
   *
   * Sequencing notes (vs the old fire-and-forget version):
   *   - CREATE_PROFILE is sent first, with SEND_RESULT requested so we
   *     log success/failure to logcat.
   *   - SET_CONFIG is sent ~250ms later to give DataWedge time to commit
   *     the profile creation. Using CONFIG_MODE=CREATE_IF_NOT_EXIST as a
   *     belt-and-braces fallback if the create broadcast was dropped.
   *   - APP_LIST is typed as Array<Bundle> (not Array<Parcelable>) which
   *     is what DataWedge's parser expects on newer DataWedge builds.
   */
  private fun configureDataWedgeProfile(commandId: String) {
    val ctx = reactApplicationContext.applicationContext
    val packageName = ctx.packageName

    // 1) Create profile (idempotent). Request a result so we know whether
    //    DataWedge accepted it.
    val createIntent = Intent(DW_ACTION).apply {
      setPackage(DATAWEDGE_PKG)
      putExtra(DW_EXTRA_CREATE_PROFILE, PROFILE_NAME)
      putExtra(DW_EXTRA_SEND_RESULT, "LAST_RESULT")
      putExtra(DW_EXTRA_COMMAND_IDENTIFIER, "$commandId-create")
    }
    ctx.sendBroadcast(createIntent)
    Log.d(TAG, "Sent CREATE_PROFILE (cmd=$commandId-create)")

    // 2) Bind profile to our app + activity. DataWedge expects APP_LIST as
    //    an array of Bundles.
    val appConfig = Bundle().apply {
      putString("PACKAGE_NAME", packageName)
      putStringArray("ACTIVITY_LIST", arrayOf("*"))
    }
    val appList: Array<Bundle> = arrayOf(appConfig)

    // 3) Configure the Intent output plugin to broadcast to SCAN_ACTION.
    val intentParams = Bundle().apply {
      putString("intent_output_enabled", "true")
      putString("intent_action", SCAN_ACTION)
      putString("intent_category", Intent.CATEGORY_DEFAULT)
      putString("intent_delivery", "2") // 2 = Broadcast Intent
    }
    val intentConfig = Bundle().apply {
      putString("PLUGIN_NAME", "INTENT")
      putString("RESET_CONFIG", "true")
      putBundle("PARAM_LIST", intentParams)
    }

    // 4) Enable the barcode plugin. Default symbologies cover SGS Code 128 +
    //    GS1-128 and IATA Interleaved 2 of 5 — see docs/zebra-datawedge-setup.md.
    val barcodeParams = Bundle().apply {
      putString("scanner_selection", "auto")
      putString("scanner_input_enabled", "true")
    }
    val barcodeConfig = Bundle().apply {
      putString("PLUGIN_NAME", "BARCODE")
      putString("RESET_CONFIG", "true")
      putBundle("PARAM_LIST", barcodeParams)
    }

    // Disable the keystroke plugin so DataWedge doesn't also type the scan
    // into focused text inputs (the agent would see double scans on any
    // form-like screen).
    val keystrokeParams = Bundle().apply {
      putString("keystroke_output_enabled", "false")
    }
    val keystrokeConfig = Bundle().apply {
      putString("PLUGIN_NAME", "KEYSTROKE")
      putString("RESET_CONFIG", "true")
      putBundle("PARAM_LIST", keystrokeParams)
    }

    val profileConfig = Bundle().apply {
      putString("PROFILE_NAME", PROFILE_NAME)
      putString("PROFILE_ENABLED", "true")
      // CREATE_IF_NOT_EXIST means SET_CONFIG works even if the upstream
      // CREATE_PROFILE broadcast was dropped (rare but observed on
      // older DataWedge builds with battery-saver agro).
      putString("CONFIG_MODE", "CREATE_IF_NOT_EXIST")
      putParcelableArray("APP_LIST", appList)
      putParcelableArray(
        "PLUGIN_CONFIG",
        arrayOf(intentConfig, barcodeConfig, keystrokeConfig),
      )
    }

    val configIntent = Intent(DW_ACTION).apply {
      setPackage(DATAWEDGE_PKG)
      putExtra(DW_EXTRA_SET_CONFIG, profileConfig)
      putExtra(DW_EXTRA_SEND_RESULT, "LAST_RESULT")
      putExtra(DW_EXTRA_COMMAND_IDENTIFIER, "$commandId-config")
    }

    // Delay the SET_CONFIG so the profile create has a chance to commit.
    mainHandler.postDelayed({
      try {
        ctx.sendBroadcast(configIntent)
        Log.d(TAG, "Sent SET_CONFIG (cmd=$commandId-config)")
        Toast.makeText(
          ctx,
          "Scanner ready\nEnabled: Code128 · ITF-14 · Code39 · PDF417",
          Toast.LENGTH_LONG,
        ).show()
      } catch (t: Throwable) {
        Log.w(TAG, "SET_CONFIG broadcast failed", t)
      }
    }, CONFIG_CHAIN_DELAY_MS)
  }

  /**
   * JS-callable escape hatch — re-runs profile setup from the Settings
   * screen if ops ever wipes DataWedge state on a device. Resolves to a
   * status object the JS layer can show in a toast.
   */
  @ReactMethod
  fun reconfigureProfile(promise: Promise) {
    try {
      if (!isDataWedgeInstalled()) {
        val result = Arguments.createMap().apply {
          putString("status", "datawedge_not_installed")
        }
        promise.resolve(result)
        return
      }
      configureDataWedgeProfile(commandId = "manual-${System.currentTimeMillis()}")
      val result = Arguments.createMap().apply {
        putString("status", "ok")
      }
      promise.resolve(result)
    } catch (t: Throwable) {
      Log.w(TAG, "Manual reconfigure failed", t)
      promise.reject("RECONFIGURE_FAILED", t.message ?: "unknown", t)
    }
  }

  /**
   * JS-callable diagnostic — reports whether DataWedge is installed on
   * this device. Used by the Settings screen to decide whether to render
   * the "Reconfigure scanner" button.
   */
  @ReactMethod
  fun isDataWedgeAvailable(promise: Promise) {
    try {
      promise.resolve(isDataWedgeInstalled())
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }
}
