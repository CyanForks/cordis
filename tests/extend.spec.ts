import { expect } from 'chai'
import { Context } from '../src'

describe('Extend', () => {
  it('basic support', () => {
    interface C1 {
      s1: S1
      s2: S2
      s3: S3
    }

    class C1 extends Context {}
    class S1 {}

    class C2 extends C1 {}
    class S2 {}

    class C3 extends C1 {}
    class S3 {}

    C2.service('s2', S2.prototype)
    C1.service('s1', S1.prototype)
    C3.service('s3', S3.prototype)

    const c1 = new C1()
    expect(c1.s1).to.be.ok
    expect(c1.s2).to.be.undefined
    expect(c1.s3).to.be.undefined

    const c2 = new C2()
    expect(c2.s1).to.be.ok
    expect(c2.s2).to.be.ok
    expect(c2.s3).to.be.undefined

    const c3 = new C3()
    expect(c3.s1).to.be.ok
    expect(c3.s2).to.be.undefined
    expect(c3.s3).to.be.ok
  })
})
