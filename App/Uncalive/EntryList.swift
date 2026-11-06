import Foundation
import Observation
import UncaliveCore

/// 글 목록 화면 하나의 상태입니다. 스크랩과 주소 수집이 각자 가집니다.
@MainActor
@Observable
final class EntryList {
    enum Kind {
        case scraps, collection
    }

    enum State: Equatable {
        case idle
        case loading(page: Int, highestPage: Int?)
        case failed(String)
    }

    enum StatusFilter: String, CaseIterable, Identifiable {
        case all = "모든 상태", new = "안 받음", incomplete = "일부만 받음", saved = "받음"
        var id: Self { self }
    }

    enum Period: String, CaseIterable, Identifiable {
        case all = "전체 기간", week = "최근 7일", month = "최근 30일", year = "최근 1년", custom = "직접 지정"
        var id: Self { self }
    }

    let kind: Kind
    var entries: [ScrapEntry] = []
    var checked = Set<String>()
    var state = State.idle

    var searchText = ""
    var channelFilter: String?
    var statusFilter = StatusFilter.all
    var period = Period.all
    var customFrom = Calendar.current.date(byAdding: .month, value: -1, to: .now) ?? .now
    var customTo = Date.now

    init(kind: Kind) {
        self.kind = kind
    }

    var isLoading: Bool {
        if case .loading = state { true } else { false }
    }

    var channels: [(id: String, name: String)] {
        var seen = Set<String>()
        return entries.compactMap { entry in
            seen.insert(entry.channel).inserted ? (entry.channel, entry.channelName ?? entry.channel) : nil
        }.sorted { $0.name < $1.name }
    }

    var checkedCount: Int {
        entries.lazy.filter { self.checked.contains($0.id) }.count
    }

    /// 작성일을 모르는 글은 기간을 정하면 보이지 않습니다.
    func matchesPeriod(_ entry: ScrapEntry) -> Bool {
        guard period != .all else { return true }
        guard let date = entry.date else { return false }
        let calendar = Calendar.current
        switch period {
        case .all: return true
        case .week: return date >= calendar.date(byAdding: .day, value: -7, to: .now) ?? .distantPast
        case .month: return date >= calendar.date(byAdding: .day, value: -30, to: .now) ?? .distantPast
        case .year: return date >= calendar.date(byAdding: .year, value: -1, to: .now) ?? .distantPast
        case .custom:
            let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: customTo)) ?? customTo
            return date >= calendar.startOfDay(for: customFrom) && date < end
        }
    }
}
