using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>
/// CRnBody::SetType (vphysics2 1801bd3e0) in full, contacts included (source2-compiler's RnWorld.SetType refuses a body
/// with contacts): what func_physbox's EnableMotion / DisableMotion come to (rubikon/CS2_RUNTIME.md). Types: 0 static,
/// 1 keyframed, 2 dynamic.
/// </summary>
public static class BodyType
{
    public static void Set(RnWorld w, RnBody body, int type, IReadOnlyList<RnMassUpdate.Shape> shapes)
    {
        ref var s = ref body.State;
        var old = s.BodyType;
        if (type == old) return;
        if (type == 0)
        {
            StepGlue.SleepBody(w, body); // FUN_1801be010
            s.LinearVelocity = default;
            s.AngularVelocity = default;
        }
        var q = s.Orientation;
        var origin = BodyOps.FrameOrigin(s);
        s.Force = default; s.Torque = default;
        s.LinearImpulse = default; s.AngularImpulse = default;
        s.LinearVelocityScale = 1f; s.AngularVelocityScale = 1f;
        if (body.MapState != 3) IslandManagerOps.Leave(w.Islands, body);
        s.BodyType = type;
        RnMassUpdate.Run(ref s, shapes, origin, q, old != 0 ? 3u : 7u); // ends in the drag (FUN_1801b9ca0)
        body.Static = type == 0;
        s.StaticFlag = (byte)(type == 0 ? 1 : 0);
        var inWorld = false;
        if ((s.Flags249 & 1) != 0)
        {
            foreach (var shape in body.Shapes) // FUN_1801b1fe0 -> FUN_1802552d0
                if (shape.ProxyId != -1) w.Broadphase?.ReselectTree(shape.Proxy);
            var contacts = ContactLifecycle.ContactsOf(body).ToList();
            foreach (var c in contacts)
            {
                if (!CollisionFilter.BodiesMayCollide(c.A.Proxy, c.B.Proxy, c.Flags78))
                {
                    ContactLifecycle.Destroy(w, c); // FUN_1801f7450
                    continue;
                }
                // FUN_1801d6470: group 0 only between two dynamic bodies
                c.Group = c.A.Body.State.BodyType == 2 && c.B.Body.State.BodyType == 2 ? 0 : 1;
                if (type == 2) ScaleImpulses(c, 0f); // FUN_1801d5930(contact, 0): no warm start
            }
            if (type == 2)
                foreach (var (j, _) in body.JointEdges) j.ScaleImpulses(0f); // +0x70, joint vfn 0x18
            inWorld = body.Index != -1; // +0x14
        }
        if (inWorld != (body.MapState != 3))
        {
            if (inWorld) IslandManagerOps.Return(w.Islands, body);
            else IslandManagerOps.Leave(w.Islands, body);
        }
        ContactLifecycle.Wake(w, body, false); // FUN_1801c0ff0(body, 0)
        // FUN_1801a20c0: each shape's observer (shape +0x90 vfn 0x40), the game's; nothing of the simulation
    }

    // FUN_1801d5930: every cached manifold's point impulses, friction and twist impulses times s
    static void ScaleImpulses(RnContact c, float s)
    {
        for (var i = 0; i < c.Manifolds.Count; i++)
        {
            var m = c.Manifolds[i];
            var pts = m.Points;
            for (var k = 0; k < m.PointCount; k++) pts[k].Impulse = s * pts[k].Impulse;
            m.Impulse1 = s * m.Impulse1;
            m.Impulse2 = s * m.Impulse2;
            m.TwistImpulse = s * m.TwistImpulse;
            c.Manifolds[i] = m;
        }
    }
}
