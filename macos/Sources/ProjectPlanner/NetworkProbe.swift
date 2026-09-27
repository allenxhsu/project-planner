import CoreLocation
import CoreWLAN
import Foundation

/// Where this Mac is, for telling home from work: the Wi-Fi network's name and
/// a rough location. macOS gives out both only once the person has allowed
/// Location Services for the app — reading a Wi-Fi name counts as location,
/// since a network name says where someone is — so the first probe asks.
/// Either can come back empty (not allowed, no Wi-Fi, no fix yet); the page
/// then decides with what it has, the internet address among it.
final class NetworkProbe: NSObject, CLLocationManagerDelegate {
    struct Reading {
        var ssid: String?
        var latitude: Double?
        var longitude: Double?
        var accuracy: Double?
    }

    private let manager = CLLocationManager()
    private var waiting: [(Reading) -> Void] = []
    private var timeout: DispatchWorkItem?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// One reading, within about ten seconds whatever happens.
    func read(_ done: @escaping (Reading) -> Void) {
        waiting.append(done)
        guard waiting.count == 1 else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()   // the answer arrives in locationManagerDidChangeAuthorization
        case .denied, .restricted:
            finish(location: nil)
            return
        default:
            manager.requestLocation()
        }
        let item = DispatchWorkItem { [weak self] in self?.finish(location: self?.manager.location) }
        timeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: item)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard !waiting.isEmpty else { return }
        switch manager.authorizationStatus {
        case .denied, .restricted: finish(location: nil)
        case .notDetermined: break
        default: manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        finish(location: locations.last)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(location: manager.location)
    }

    private func finish(location: CLLocation?) {
        timeout?.cancel()
        timeout = nil
        guard !waiting.isEmpty else { return }
        let reading = Reading(
            ssid: CWWiFiClient.shared().interface()?.ssid(),
            latitude: location?.coordinate.latitude,
            longitude: location?.coordinate.longitude,
            accuracy: location?.horizontalAccuracy
        )
        let callbacks = waiting
        waiting = []
        callbacks.forEach { $0(reading) }
    }
}
