import {Observable} from 'rxjs'

/** Add new subscriptions immediately, retire previous routes after bounded overlap. */
export function handover(source: Observable<string[]>, graceMs = 30000): Observable<string[]> {
  return new Observable(subscriber => {
    let desired: string[] = []
    const retired = new Map<string, ReturnType<typeof setTimeout>>()
    const emit = () => subscriber.next([...new Set([...desired, ...retired.keys()])])
    const clear = () => { for (const timer of retired.values()) clearTimeout(timer); retired.clear() }
    const sub = source.subscribe({
      next: next => {
        for (const url of desired) if (!next.includes(url) && !retired.has(url)) {
          retired.set(url, setTimeout(() => { retired.delete(url); emit() }, graceMs))
        }
        for (const url of next) { clearTimeout(retired.get(url)); retired.delete(url) }
        desired = next
        emit()
      },
      error: error => subscriber.error(error),
      complete: () => subscriber.complete(),
    })
    return () => { sub.unsubscribe(); clear() }
  })
}
