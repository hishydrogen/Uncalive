import Foundation

/// 동시 연결 수를 제한합니다. 우선순위가 높은 요청은 대기열 앞쪽으로 갑니다.
public actor Limiter {
    private let limit: Int
    private var used = 0
    private var urgent: [CheckedContinuation<Void, Never>] = []
    private var normal: [CheckedContinuation<Void, Never>] = []

    public init(limit: Int) {
        self.limit = max(limit, 1)
    }

    private func acquire(urgent isUrgent: Bool) async {
        guard used >= limit else {
            used += 1
            return
        }
        await withCheckedContinuation { continuation in
            if isUrgent { urgent.append(continuation) } else { normal.append(continuation) }
        }
    }

    private func release() {
        if !urgent.isEmpty {
            urgent.removeFirst().resume()
        } else if !normal.isEmpty {
            normal.removeFirst().resume()
        } else {
            used -= 1
        }
    }

    public nonisolated func withSlot<T: Sendable>(urgent: Bool = false, _ body: @Sendable () async throws -> T) async throws -> T {
        await acquire(urgent: urgent)
        do {
            try Task.checkCancellation()
            let value = try await body()
            await release()
            return value
        } catch {
            await release()
            throw error
        }
    }
}
